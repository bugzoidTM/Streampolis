import { config } from './config.js';
import { pool } from './db.js';
import { warn } from './log.js';

/**
 * O único caminho até um modelo de linguagem.
 *
 * Duas camadas (`chat` e `deep`), um orçamento diário e um registro por
 * chamada — latência, tamanho, erro. "Mensurável" começa por aqui: sem esta
 * tabela, "o personagem está lento" ou "o modelo devolve lixo" são impressões.
 *
 * Os dois destinos são fachadas OpenAI que dirigem interfaces web de graça
 * (qwenproxy, chatgptproxy). Elas engasgam: por isso o timeout é largo, há
 * UMA retentativa, e a recusa do proxy (limite de tokens devolvido como
 * sucesso, ver a memória do chatgptproxy) é tratada como erro pelo chamador,
 * que sabe qual formato esperava.
 */

export type Tier = 'chat' | 'deep';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  ok: boolean;
  text: string;
  error?: string;
  latencyMs: number;
  model: string;
}

interface Budget {
  day: string;
  used: number;
}

const budget: Budget = { day: '', used: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Quantas chamadas ainda cabem hoje. Zera à meia-noite UTC. */
export function budgetLeft(): number {
  const d = today();
  if (budget.day !== d) {
    budget.day = d;
    budget.used = 0;
  }
  return Math.max(0, config.llm.dailyBudget - budget.used);
}

export function budgetUsed(): number {
  budgetLeft();
  return budget.used;
}

function extractText(body: unknown): string {
  const b = body as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = b?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  // Alguns proxies devolvem partes (texto multimodal).
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? ''))
      .join('');
  }
  return '';
}

async function once(tier: Tier, messages: ChatTurn[], maxTokens: number): Promise<LlmResult> {
  const t = config.llm[tier];
  const started = Date.now();
  try {
    const res = await fetch(t.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${t.key}`,
      },
      body: JSON.stringify({
        model: t.model,
        messages,
        temperature: tier === 'chat' ? 0.8 : 0.4,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, text: '', error: `http ${res.status}: ${body.slice(0, 200)}`, latencyMs, model: t.model };
    }
    const json = (await res.json()) as unknown;
    const text = extractText(json).trim();
    if (!text) return { ok: false, text: '', error: 'resposta vazia', latencyMs, model: t.model };
    return { ok: true, text, latencyMs, model: t.model };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ok: false, text: '', error: msg.slice(0, 200), latencyMs, model: t.model };
  }
}

async function record(npcId: string, tier: Tier, purpose: string, promptChars: number, r: LlmResult): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO npc_calls (npc_id, tier, purpose, model, ok, error, latency_ms, prompt_chars, reply_chars)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [npcId, tier, purpose, r.model, r.ok, r.error ?? null, r.latencyMs, promptChars, r.text.length],
    );
  } catch (err) {
    warn('llm', 'não registrou a chamada', { err: String(err) });
  }
}

export interface CallOptions {
  npcId: string;
  tier: Tier;
  /** Vai para `npc_calls.purpose`; letras e sublinhado. */
  purpose: string;
  messages: ChatTurn[];
  maxTokens?: number;
  /** Uma retentativa quando o proxy engasga (timeout, 5xx, vazio). */
  retry?: boolean;
}

export async function call(opts: CallOptions): Promise<LlmResult> {
  if (budgetLeft() <= 0) {
    return { ok: false, text: '', error: 'orçamento diário esgotado', latencyMs: 0, model: config.llm[opts.tier].model };
  }
  budget.used++;
  const promptChars = opts.messages.reduce((n, m) => n + m.content.length, 0);
  const maxTokens = opts.maxTokens ?? (opts.tier === 'chat' ? 200 : 1600);
  let result = await once(opts.tier, opts.messages, maxTokens);
  if (!result.ok && opts.retry !== false && budgetLeft() > 0) {
    budget.used++;
    await record(opts.npcId, opts.tier, opts.purpose, promptChars, result);
    result = await once(opts.tier, opts.messages, maxTokens);
  }
  await record(opts.npcId, opts.tier, opts.purpose, promptChars, result);
  return result;
}

/**
 * Tira um objeto JSON de uma resposta que pode vir embrulhada em cerca de
 * código, com texto antes ou depois. O modelo é instruído a devolver só JSON e
 * mesmo assim não devolve — sempre.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.unshift(fence[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // próximo candidato
    }
  }
  return null;
}
