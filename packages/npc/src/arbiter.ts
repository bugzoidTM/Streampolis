import { isAddressed } from './brain.js';

/**
 * Quem responde a uma fala que não nomeia ninguém.
 *
 * Antes, todo personagem a menos de 4,5 m respondia — e numa rodinha três
 * respondiam de uma vez a um "oi". Agora, para cada mensagem sem
 * destinatário, o processo decide UMA vez quem fala (todos os personagens
 * da sala vivem no mesmo processo, então a primeira cabeça a receber a
 * mensagem decide e as outras leem a decisão):
 *
 *   1. quem já está em conversa com a pessoa (respondeu há menos de 60 s) e
 *      continua a até 10 m — a conversa não muda de mão porque alguém passou;
 *   2. senão, quem a pessoa está ENCARANDO (o `yaw` dela vem da sala), a até
 *      4,5 m, desempatando pela distância;
 *   3. senão, ninguém.
 *
 * Fala que nomeia um personagem vai para ele e só para ele — inclusive quando
 * o Nilo está do lado. Figurantes de ambiente nunca entram aqui: só falam
 * quando chamados pelo nome.
 */
export interface Candidate {
  npcId: string;
  x: number;
  z: number;
}

export interface Speaker {
  x: number;
  z: number;
  yaw: number;
}

export const ARBITER = {
  nearM: 4.5,
  holdM: 10,
  holdMs: 60_000,
  /** Cosseno mínimo entre o olhar da pessoa e a direção do personagem para contar como "encarando". */
  facing: 0.35,
} as const;

const decisions = new Map<string, { npcId: string | null; at: number }>();
const holders = new Map<string, { npcId: string; at: number }>();

function sweep(now: number): void {
  if (decisions.size < 500) return;
  for (const [k, v] of decisions) if (now - v.at > 120_000) decisions.delete(k);
}

/** Quem tem a conversa com esta pessoa agora, se alguém. */
export function holderOf(userId: string, now = Date.now()): string | null {
  const h = holders.get(userId);
  return h && now - h.at < ARBITER.holdMs ? h.npcId : null;
}

/** Um personagem acabou de responder a esta pessoa: a conversa é dele por um tempo. */
export function claim(userId: string, npcId: string, now = Date.now()): void {
  holders.set(userId, { npcId, at: now });
}

/** Sem resposta há tempo demais: solta. */
export function release(userId: string, npcId: string): void {
  if (holders.get(userId)?.npcId === npcId) holders.delete(userId);
}

/** A fala nomeia algum destes personagens? */
export function namesAny(text: string, names: readonly string[]): boolean {
  return names.some((n) => isAddressed(text, n));
}

/**
 * Decide (ou lê a decisão já tomada) para a mensagem `msgId`. `candidates`
 * são os personagens que a cabeça decisora vê perto da pessoa, ela inclusa.
 */
export function decide(msgId: string, userId: string, speaker: Speaker, candidates: readonly Candidate[], now = Date.now()): string | null {
  const done = decisions.get(msgId);
  if (done) return done.npcId;
  sweep(now);
  let winner: string | null = null;
  const holder = holderOf(userId, now);
  const holding = holder ? candidates.find((c) => c.npcId === holder) : undefined;
  if (holding && Math.hypot(holding.x - speaker.x, holding.z - speaker.z) <= ARBITER.holdM) {
    winner = holder;
  } else {
    const fx = Math.sin(speaker.yaw);
    const fz = Math.cos(speaker.yaw);
    let best = -Infinity;
    for (const c of candidates) {
      const dx = c.x - speaker.x;
      const dz = c.z - speaker.z;
      const d = Math.hypot(dx, dz);
      if (d > ARBITER.nearM) continue;
      const facing = d < 1e-3 ? 1 : (dx * fx + dz * fz) / d;
      if (facing < ARBITER.facing && d > 1.5) continue;
      const score = facing * 2 - d / ARBITER.nearM;
      if (score > best) { best = score; winner = c.npcId; }
    }
  }
  decisions.set(msgId, { npcId: winner, at: now });
  return winner;
}

/** Só para testes. */
export function resetArbiter(): void {
  decisions.clear();
  holders.clear();
}
