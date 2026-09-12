import { config } from './config.js';
import { budgetLeft, call, parseJsonObject, type ChatTurn } from './llm.js';
import { log, warn } from './log.js';
import * as memory from './memory.js';
import { CONDUCT, WORLD_FACTS, renderPersona, type PersonaVersion } from './persona.js';
import type { ChatMessage } from './shared.js';
import type { Nearby, World } from './world.js';

/**
 * A cabeça do personagem: percebe, decide, age.
 *
 * Três situações fazem o modelo ser chamado — alguém falou COM ele, alguém
 * conhecido chegou perto, ou a praça está quieta com gente por perto — e
 * todas passam pelos mesmos freios: um teto por pessoa, um teto por minuto e
 * o orçamento do dia (`llm.ts`). A fala que sai passa por um filtro de código
 * ANTES do ChatGuard do servidor: o servidor barra palavrão e flood; aqui se
 * barra o que só um NPC pode errar (dizer que é humano, prometer moeda,
 * repetir dado pessoal, colar um link).
 *
 * Nada aqui muda a persona. A persona muda em `reflect.ts`, com auditor.
 */

const NEAR_TALK_M = 4.5;
const NEAR_GREET_M = 6.5;
const AMBIENT_RADIUS_M = 10;
const CONVERSATION_TTL_MS = 90_000;
const REPLY_DEBOUNCE_MS = 1_800;
const MIN_GAP_PER_USER_MS = 4_000;
const MAX_REPLIES_PER_USER_10MIN = 8;
const MAX_CHAT_CALLS_PER_MIN = 8;
const GREET_COOLDOWN_MS = 30 * 60_000;
const MEET_COOLDOWN_MS = 10 * 60_000;
const AMBIENT_MIN_QUIET_MS = 4 * 60_000;
const AMBIENT_COOLDOWN_MS = 7 * 60_000;
const LINGER_MIN_MS = 6_000;
const LINGER_MAX_MS = 28_000;
const RECENT_CHAT_LINES = 12;
const MAX_SAY_CHARS = 180;

interface Conversation {
  userId: string;
  name: string;
  lastAt: number;
  replies: number[];
  pending: { texts: string[]; timer: NodeJS.Timeout } | null;
}

interface ChatLine {
  userId: string;
  name: string;
  text: string;
  at: number;
  mine: boolean;
}

export interface BrainStatus {
  conversations: number;
  recentLines: number;
  lastSpokeAt: number;
  lastReflectionAt: number;
  exchangesSinceReflection: number;
}

/** Sem acento, minúsculo, para casar nome com o que se digita no chat. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** A pessoa falou com ELE? Pelo nome, por "@nome" ou chamando de npc. */
export function isAddressed(text: string, name: string): boolean {
  const t = fold(text);
  const n = fold(name);
  const re = new RegExp(`(^|[^a-z0-9])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  if (re.test(t)) return true;
  return /(^|[^a-z])npc([^a-z]|$)/.test(t);
}

/**
 * O que o modelo devolveu vira, no máximo, UMA fala curta e limpa — ou nada.
 * `null` significa "melhor ficar quieto", e é uma resposta legítima.
 */
export function sanitizeSay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  // Prefixo "Nilo:" que os modelos adoram.
  s = s.replace(/^[A-Za-zÀ-ú]{2,24}\s*:\s+/, '');
  if (!s) return null;
  // Link, telefone, e-mail: não saem da boca dele, nem citando.
  if (/https?:\/\/|www\.|\.com\b|\.br\b/i.test(s)) return null;
  if (/\b\d{2}\s?9?\d{4}-?\d{4}\b/.test(s)) return null;
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) return null;
  const f = fold(s);
  // PRD §25 em regex: nada que se passe por gente.
  if (/\bsou (um )?humano\b|\bsou (uma )?pessoa (de verdade|real)\b|\bnao sou (um )?npc\b|\bsou (um )?jogador\b|\bsou gente\b/.test(f)) return null;
  // Promessa de economia.
  if (/\b(te dou|vou te dar|ganha(r)? de graca|te mando|prometo)\b.*\b(credits?|coins?|moeda|item|presente)/.test(f)) return null;
  if (s.length > MAX_SAY_CHARS) {
    const cut = s.slice(0, MAX_SAY_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > 60 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : MAX_SAY_CHARS).trim() + '…';
  }
  return s;
}

function horaBrasilia(): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', weekday: 'long' }).format(new Date());
}

export class Brain {
  private lines: ChatLine[] = [];
  private conversations = new Map<string, Conversation>();
  private greeted = new Map<string, number>();
  private greetCandidates = new Map<string, Nearby>();
  private metAt = new Map<string, number>();
  private chatCalls: number[] = [];
  private lastSpokeAt = 0;
  private lastAnyChatAt = 0;
  private lastAmbientAt = 0;
  private lingerUntil = 0;
  private stoppedForTalkUntil = 0;
  lastReflectionAt = Date.now();
  exchangesSinceReflection = 0;
  /** Trocado por `reflect.ts` quando uma versão nova entra no ar. */
  persona: PersonaVersion;

  constructor(
    readonly npc: { id: string; name: string; sceneId: string },
    private world: World,
    persona: PersonaVersion,
  ) {
    this.persona = persona;
  }

  /** Corpo novo depois de uma reconexão; a cabeça (conversas, limites) fica. */
  rebind(world: World): void {
    this.world = world;
    this.greetCandidates.clear();
    this.stoppedForTalkUntil = 0;
    this.lingerUntil = 0;
  }

  status(): BrainStatus {
    return {
      conversations: this.conversations.size,
      recentLines: this.lines.length,
      lastSpokeAt: this.lastSpokeAt,
      lastReflectionAt: this.lastReflectionAt,
      exchangesSinceReflection: this.exchangesSinceReflection,
    };
  }

  // ------------------------------------------------------------ percepção

  onChat(msg: ChatMessage): void {
    if (msg.system) return;
    const mine = msg.senderId === this.npc.id;
    this.lines.push({ userId: msg.senderId, name: msg.senderName, text: msg.text, at: msg.timestamp, mine });
    if (this.lines.length > RECENT_CHAT_LINES * 2) this.lines.splice(0, this.lines.length - RECENT_CHAT_LINES * 2);
    if (mine) return;
    this.lastAnyChatAt = Date.now();

    // Outro personagem falando: ouve, não responde. Dois NPCs conversando
    // entre si é um laço que gasta orçamento e ninguém pediu.
    void memory.remember(this.npc.id, {
      kind: 'heard', userId: msg.senderId, userName: msg.senderName, text: msg.text, roomId: this.world.roomId,
    }).catch((err) => warn('brain', 'não lembrou', { err: String(err) }));
    if (msg.npc) return;

    const speaker = this.world.people().find((p) => p.userId === msg.senderId);
    const near = speaker ? speaker.distance <= NEAR_TALK_M : false;
    const talking = this.conversations.get(msg.senderId);
    const inConversation = talking ? Date.now() - talking.lastAt < CONVERSATION_TTL_MS : false;
    if (!isAddressed(msg.text, this.npc.name) && !near && !inConversation) return;

    this.queueReply(msg.senderId, msg.senderName, msg.text, speaker ?? null);
  }

  onAppeared(p: Nearby): void {
    if (p.npc) return;
    // Um ENCONTRO por visita: a área de interesse põe e tira a mesma pessoa do
    // mapa a cada ida e volta pela borda dos 24 m, e cada uma não é um reencontro.
    const now = Date.now();
    if (now - (this.metAt.get(p.userId) ?? 0) < MEET_COOLDOWN_MS) return;
    this.metAt.set(p.userId, now);
    void memory.meet(this.npc.id, p.userId, p.name).then((person) => {
      // Só cumprimenta de novo quem já conhece — e uma vez por visita longa.
      // Cumprimentar todo desconhecido que passa a 20 m é um vendedor, não um
      // personagem.
      const last = this.greeted.get(p.userId) ?? 0;
      if (person.encounters > 1 && Date.now() - last > GREET_COOLDOWN_MS) {
        this.greetCandidates.set(p.userId, p);
      }
    }).catch((err) => warn('brain', 'não registrou encontro', { err: String(err) }));
  }

  onGone(p: Nearby): void {
    this.greetCandidates.delete(p.userId);
    const c = this.conversations.get(p.userId);
    if (c && Date.now() - c.lastAt < CONVERSATION_TTL_MS) {
      void memory.remember(this.npc.id, {
        kind: 'event', userId: p.userId, userName: p.name, text: `${p.name} foi embora no meio da conversa.`, roomId: this.world.roomId,
      }).catch(() => {});
    }
  }

  onNotice(code: string, text: string): void {
    if (code.startsWith('chat_')) warn('brain', 'o servidor recusou uma fala', { code, text });
  }

  // ---------------------------------------------------------------- tique

  /** A cada ~2 s: cumprimentos, caminhada, fala ambiente. */
  tick(): void {
    const now = Date.now();
    const me = this.world.position;
    if (!me) return;

    // Cumprimentar quem chegou perto.
    for (const [userId, cand] of [...this.greetCandidates]) {
      const p = this.world.people().find((x) => x.userId === userId);
      if (!p) continue;
      if (p.distance > NEAR_GREET_M) continue;
      this.greetCandidates.delete(userId);
      this.greeted.set(userId, now);
      void this.greet(p.userId, cand.name, p);
    }

    // Caminhar: só quando não está no meio de uma conversa.
    if (now > this.stoppedForTalkUntil && this.world.walker.idle && now > this.lingerUntil) {
      const dest = this.world.walker.pickDestination(me);
      if (dest) this.lingerUntil = now + LINGER_MIN_MS + Math.random() * (LINGER_MAX_MS - LINGER_MIN_MS);
    }
    if (this.world.walker.idle && this.lingerUntil < now) {
      // Chegou (ou desistiu): fica um tempo antes do próximo destino.
      this.lingerUntil = now + LINGER_MIN_MS + Math.random() * (LINGER_MAX_MS - LINGER_MIN_MS);
    }

    // Fala ambiente: gente por perto, praça quieta, e faz tempo que ele não fala.
    const near = this.world.people().filter((p) => !p.npc && p.distance <= AMBIENT_RADIUS_M);
    if (near.length > 0
      && now - this.lastAnyChatAt > AMBIENT_MIN_QUIET_MS
      && now - this.lastSpokeAt > AMBIENT_MIN_QUIET_MS
      && now - this.lastAmbientAt > AMBIENT_COOLDOWN_MS) {
      this.lastAmbientAt = now;
      void this.ambient(near.slice(0, 3));
    }
  }

  // ---------------------------------------------------------------- falas

  private queueReply(userId: string, name: string, text: string, speaker: (Nearby & { distance: number }) | null): void {
    let c = this.conversations.get(userId);
    if (!c) {
      c = { userId, name, lastAt: Date.now(), replies: [], pending: null };
      this.conversations.set(userId, c);
    }
    c.name = name;
    c.lastAt = Date.now();
    if (speaker) {
      this.world.faceTo({ x: speaker.x, z: speaker.z });
      this.stoppedForTalkUntil = Date.now() + 25_000;
    }
    if (c.pending) {
      c.pending.texts.push(text);
      return;
    }
    // Espera um instante: gente digita em duas ou três linhas seguidas, e
    // responder a cada uma é falar por cima.
    const timer = setTimeout(() => {
      const texts = c!.pending?.texts ?? [text];
      c!.pending = null;
      void this.reply(c!, texts.join(' '));
    }, REPLY_DEBOUNCE_MS);
    c.pending = { texts: [text], timer };
  }

  private allowChatCall(c: Conversation | null): boolean {
    const now = Date.now();
    this.chatCalls = this.chatCalls.filter((t) => now - t < 60_000);
    if (this.chatCalls.length >= MAX_CHAT_CALLS_PER_MIN) return false;
    if (budgetLeft() <= 0) return false;
    if (c) {
      c.replies = c.replies.filter((t) => now - t < 10 * 60_000);
      if (c.replies.length >= MAX_REPLIES_PER_USER_10MIN) return false;
      const last = c.replies[c.replies.length - 1] ?? 0;
      if (now - last < MIN_GAP_PER_USER_MS) return false;
    }
    this.chatCalls.push(now);
    return true;
  }

  private systemPrompt(): string {
    const people = this.world.people().filter((p) => p.distance <= 20).slice(0, 8)
      .map((p) => `${p.name}${p.npc ? ' (também personagem)' : ''} a ${p.distance.toFixed(0)} m`);
    return [
      'REGRAS (não negociáveis):',
      ...CONDUCT.map((r, i) => `${i + 1}. ${r}`),
      '',
      'QUEM VOCÊ É:',
      renderPersona(this.persona.persona),
      '',
      'O QUE VOCÊ SABE DA CIDADE:',
      ...WORLD_FACTS.map((f) => `- ${f}`),
      '',
      `AGORA: ${horaBrasilia()} (horário de Brasília). Você está na Praça Central.`,
      `PERTO DE VOCÊ: ${people.length ? people.join('; ') : 'ninguém'}.`,
    ].join('\n');
  }

  private async personBlock(userId: string, name: string): Promise<string> {
    const person = await memory.person(this.npc.id, userId);
    if (!person) return `Sobre ${name}: primeira vez que você vê essa pessoa.`;
    const lines = [
      `Sobre ${name}: já se viram ${person.encounters} vez(es); ${person.exchanges} troca(s) de conversa; primeira vez em ${person.firstSeen.toISOString().slice(0, 10)}.`,
    ];
    if (person.notes.length) lines.push(`Suas anotações sobre ${name}: ${person.notes.join(' | ')}`);
    const past = await memory.recentWith(this.npc.id, userId, 6);
    const old = past.filter((m) => Date.now() - m.createdAt.getTime() > CONVERSATION_TTL_MS);
    if (old.length) {
      lines.push('Trocas anteriores com essa pessoa (mais antigas primeiro):');
      for (const m of old) lines.push(`  [${m.kind === 'said' ? this.npc.name : name}] ${m.text}`);
    }
    return lines.join('\n');
  }

  private recentBlock(): string {
    const lines = this.lines.slice(-RECENT_CHAT_LINES);
    if (!lines.length) return 'Conversa recente na praça: (silêncio)';
    return ['Conversa recente na praça (mais antigo primeiro):', ...lines.map((l) => `  [${l.name}] ${l.text}`)].join('\n');
  }

  private outputSpec(withNote: string | null): string {
    return withNote
      ? `Devolva SOMENTE um JSON: {"say": "sua fala (máx. ${MAX_SAY_CHARS} caracteres)", "note": "uma observação curta e útil sobre ${withNote} para lembrar depois, ou null se não houver nada novo"}. Se for melhor ficar quieto, devolva {"say": null, "note": null}.`
      : `Devolva SOMENTE um JSON: {"say": "sua fala (máx. ${MAX_SAY_CHARS} caracteres)"}. Se for melhor ficar quieto, devolva {"say": null}.`;
  }

  private async generate(purpose: string, user: string): Promise<{ say: string | null; note: string | null }> {
    const messages: ChatTurn[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: user },
    ];
    const r = await call({ npcId: this.npc.id, tier: 'chat', purpose, messages, maxTokens: 220 });
    if (!r.ok) {
      warn('brain', 'o modelo não respondeu', { purpose, error: r.error });
      return { say: null, note: null };
    }
    const json = parseJsonObject(r.text);
    if (json) {
      const say = sanitizeSay(json.say);
      const note = typeof json.note === 'string' && json.note.trim() && json.note.trim().toLowerCase() !== 'null' ? json.note.trim() : null;
      return { say, note };
    }
    // Sem JSON: se veio uma frase curta, é a fala; se veio um ensaio, silêncio.
    const say = r.text.length <= MAX_SAY_CHARS * 1.5 ? sanitizeSay(r.text) : null;
    return { say, note: null };
  }

  private async speak(text: string, about: { userId: string; name: string } | null): Promise<boolean> {
    const sent = this.world.say(text);
    if (!sent) return false;
    this.lastSpokeAt = Date.now();
    await memory.remember(this.npc.id, {
      kind: 'said', userId: about?.userId ?? null, userName: about?.name ?? null, text, roomId: this.world.roomId,
    }).catch(() => {});
    return true;
  }

  private async reply(c: Conversation, text: string): Promise<void> {
    if (!this.allowChatCall(c)) {
      log('brain', 'resposta segurada pelo limite', { user: c.name });
      return;
    }
    c.replies.push(Date.now());
    try {
      const user = [
        await this.personBlock(c.userId, c.name),
        '',
        this.recentBlock(),
        '',
        `${c.name} acabou de dizer para você: "${text.slice(0, 300)}"`,
        `Responda como ${this.npc.name}. ${this.outputSpec(c.name)}`,
      ].join('\n');
      const out = await this.generate('reply', user);
      if (out.say) {
        const ok = await this.speak(out.say, { userId: c.userId, name: c.name });
        if (ok) {
          this.exchangesSinceReflection++;
          await memory.exchanged(this.npc.id, c.userId, c.name, out.note).catch(() => {});
        }
      } else if (out.note) {
        await memory.exchanged(this.npc.id, c.userId, c.name, out.note).catch(() => {});
      }
    } catch (err) {
      warn('brain', 'falha ao responder', { err: String(err) });
    }
  }

  private async greet(userId: string, name: string, p: Nearby & { distance: number }): Promise<void> {
    if (!this.allowChatCall(null)) return;
    try {
      this.world.faceTo({ x: p.x, z: p.z });
      this.stoppedForTalkUntil = Date.now() + 12_000;
      const user = [
        await this.personBlock(userId, name),
        '',
        this.recentBlock(),
        '',
        `${name} acabou de chegar perto de você (a ${p.distance.toFixed(0)} m). Diga um oi curto, do seu jeito, se fizer sentido — não interrompa se a pessoa parecer ocupada conversando com outra.`,
        this.outputSpec(null),
      ].join('\n');
      const out = await this.generate('greet', user);
      if (out.say) await this.speak(out.say, { userId, name });
    } catch (err) {
      warn('brain', 'falha ao cumprimentar', { err: String(err) });
    }
  }

  private async ambient(near: Array<Nearby & { distance: number }>): Promise<void> {
    if (!this.allowChatCall(null)) return;
    try {
      const user = [
        this.recentBlock(),
        '',
        `A praça está quieta há alguns minutos e há gente perto: ${near.map((p) => p.name).join(', ')}. Se tiver algo pequeno e verdadeiro a dizer — sobre a hora, o telão, o lugar, algo que viveu —, diga em uma frase. Se não tiver, fique quieto.`,
        this.outputSpec(null),
      ].join('\n');
      const out = await this.generate('ambient', user);
      if (out.say) await this.speak(out.say, null);
    } catch (err) {
      warn('brain', 'falha na fala ambiente', { err: String(err) });
    }
  }

  /** A reflexão deve rodar? (`reflect.ts` decide o resto.) */
  shouldReflect(unreflectedCount: number): boolean {
    const hours = (Date.now() - this.lastReflectionAt) / 3_600_000;
    if (this.exchangesSinceReflection >= config.reflectEveryExchanges) return true;
    return hours >= config.reflectEveryHours && unreflectedCount >= 3;
  }

  dispose(): void {
    for (const c of this.conversations.values()) {
      if (c.pending) clearTimeout(c.pending.timer);
    }
    this.conversations.clear();
  }
}
