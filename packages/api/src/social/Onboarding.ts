import { pool } from '../db/pool.ts';
import type { PresenceEntry } from './PresenceDirectory.ts';

/**
 * Onboarding de conta nova (PRD §24).
 *
 * Cinco atos, na ordem em que o produto quer que a primeira sessão aconteça:
 * criar o avatar, entrar na praça, assistir a uma live, visitar um apartamento
 * e abrir a própria live. Não são missões (essas vêm depois, com recompensa e
 * repetição) — é uma volta guiada pelo jogo, e cada passo é o menor ato que
 * prova que a pessoa achou aquela parte.
 *
 * ## Quem marca é quem VÊ
 *
 * O passo é escrito quando o servidor observa o ato, nunca quando o cliente diz
 * que fez. "Entrou na praça", "assistiu", "abriu live" chegam do retrato de
 * presença que o game server publica (SPECs §17) — que é a mesma fonte que
 * responde onde alguém está, e é autoridade porque é ela que tem o socket.
 * "Criou o avatar" chega do PUT que gravou a aparência.
 *
 * A alternativa — o navegador chamando `POST /me/onboarding/watch_live` — seria
 * uma lista de tarefas completável com o console aberto, e o primeiro dia do
 * jogador é exatamente onde uma lista assim precisa ser verdade.
 *
 * ## Ausência é o estado inicial
 *
 * Uma linha por passo CUMPRIDO. Não existe "pendente" guardado: quem não tem a
 * linha ainda não fez, e um sexto passo pode nascer amanhã sem tocar na conta
 * de ninguém.
 */

export const ONBOARDING_STEPS = [
  'create_avatar',
  'enter_plaza',
  'watch_live',
  'visit_apartment',
  'open_live',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const STEP_SET: ReadonlySet<string> = new Set(ONBOARDING_STEPS);

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && STEP_SET.has(value);
}

/**
 * Que passo este registro de presença prova.
 *
 * Pura e sem banco de propósito: é a única regra interessante deste arquivo e a
 * que mais fácil erra em silêncio (um host que transmite de casa está numa cena
 * `apartment` E transmitindo). A ordem dos testes é a resposta: o que a pessoa
 * está FAZENDO ganha da cena em que ela está.
 */
export function stepForPresence(entry: Pick<PresenceEntry, 'sceneId' | 'kind'>): OnboardingStep | null {
  if (entry.kind === 'streaming' || entry.kind === 'in_pk') return 'open_live';
  if (entry.kind === 'watching_live') return 'watch_live';
  if (entry.sceneId === 'apartment') return 'visit_apartment';
  if (entry.sceneId === 'central_plaza') return 'enter_plaza';
  // Loja, saguão e torre da agência não são passo nenhum: a volta guiada tem
  // cinco atos e passar por um corredor não é um deles.
  return null;
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * O que já foi escrito neste processo.
 *
 * Um passo é permanente: uma vez gravado, não volta atrás. O retrato de
 * presença chega a cada 15 segundos de cada game server com TODO MUNDO dentro —
 * sem esta memória, uma praça com cem pessoas viraria cem `INSERT ... ON
 * CONFLICT DO NOTHING` por batimento, para sempre, para não escrever nada.
 *
 * Perder o cache num restart custa uma rodada de inserts que não fazem nada.
 */
const written = new Set<string>();
/** Teto de memória: um servidor longevo não pode crescer sem fim por causa disto. */
const WRITTEN_CAP = 50_000;

/** Marca um passo. Idempotente; a segunda vez não custa nem ida ao banco. */
export async function markStep(userId: string, step: OnboardingStep): Promise<void> {
  // O token de desenvolvimento do game server é o próprio nome do usuário
  // ("ana"), e o retrato de presença aceita isso (ver o schema em server.ts).
  // Aqui não dá: a coluna é UUID com chave estrangeira.
  if (!UUID.test(userId)) return;

  const key = `${userId}:${step}`;
  if (written.has(key)) return;

  try {
    await pool.query(
      `INSERT INTO onboarding_steps (user_id, step) VALUES ($1, $2)
       ON CONFLICT (user_id, step) DO NOTHING`,
      [userId, step],
    );
    if (written.size >= WRITTEN_CAP) written.clear();
    written.add(key);
  } catch {
    // Onboarding é enfeite: uma linha perdida vira um item da lista que demora
    // um batimento a mais para acender. Falhar aqui não pode derrubar a rota
    // que chamou — a de presença move o mapa da cidade inteira.
  }
}

/**
 * Lê o retrato de presença e escreve o que ele prova.
 *
 * Chamada sem `await` por quem recebe o retrato: a resposta ao game server não
 * espera o banco. É a mesma decisão do próprio diretório de presença — o que
 * vale ali é o batimento seguinte, não esta ida ao Postgres.
 */
export function observePresence(entries: readonly PresenceEntry[]): void {
  for (const entry of entries) {
    const step = stepForPresence(entry);
    if (step) void markStep(entry.userId, step);
  }
}

export interface OnboardingView {
  steps: Array<{ step: OnboardingStep; done: boolean; doneAt: string | null }>;
  /** O primeiro passo que falta, na ordem do roteiro. `null` quando acabou. */
  next: OnboardingStep | null;
  completed: number;
  total: number;
  done: boolean;
}

export async function getOnboarding(userId: string): Promise<OnboardingView> {
  const { rows } = await pool.query<{ step: OnboardingStep; done_at: Date }>(
    'SELECT step, done_at FROM onboarding_steps WHERE user_id = $1',
    [userId],
  );
  const doneAt = new Map(rows.map((r) => [r.step, r.done_at]));

  // A ordem é a do roteiro, não a do banco: a tela desenha a volta guiada na
  // sequência em que ela deve ser feita.
  const steps = ONBOARDING_STEPS.map((step) => ({
    step,
    done: doneAt.has(step),
    doneAt: doneAt.get(step)?.toISOString() ?? null,
  }));
  const completed = steps.filter((s) => s.done).length;

  return {
    steps,
    next: steps.find((s) => !s.done)?.step ?? null,
    completed,
    total: ONBOARDING_STEPS.length,
    done: completed === ONBOARDING_STEPS.length,
  };
}

/** Só para teste: o cache de "já escrevi" é do processo, não do banco. */
export function resetOnboardingCache(): void {
  written.clear();
}
