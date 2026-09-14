import type { ChatMessage } from './shared.js';
import type { Nearby, World } from './world.js';

/**
 * A cabeça de um personagem, seja ela qual for.
 *
 * Três classes de personagem dividem o MESMO corpo (`World` + `Walker`) e
 * diferem só aqui:
 *
 *   - **cognitivo** (`Brain`): guiado por um modelo de linguagem, com persona
 *     versionada, memória, objetivos e decisão própria — o Nilo;
 *   - **social** (`SocialMind`): parece ter vontade, e tem — mas dentro de uma
 *     caixa de possibilidades que o código controla: personalidade em números,
 *     humor, necessidades, relações que crescem e esfriam, falas por modelo.
 *     Nenhuma chamada a modelo de linguagem;
 *   - **ambiente** (`AmbientMind`): máquina de estados e rotina. Sem vontade:
 *     cumpre um programa (andar, ficar, sentar, dançar) e, quando muito, tem
 *     uma fala de balcão para quem o chama pelo nome.
 *
 * O corpo não sabe qual cabeça o move; o processo (`index.ts`) também não
 * distingue além de escolher qual construir. Tudo o que reage à posição de
 * alguém continua nas pernas (`Walker`), a 8 Hz; aqui se decide, a cada 2 s.
 */
export interface Mind {
  tick(): void;
  onChat(msg: ChatMessage): void;
  onAppeared(p: Nearby): void;
  onGone(p: Nearby): void;
  onNotice(code: string, text: string): void;
  /** Corpo novo depois de uma reconexão; a cabeça continua a mesma. */
  rebind(world: World): void;
  dispose(): void;
  status(): Record<string, unknown>;
}

/** Gerador pseudoaleatório determinístico, semeado por personagem: o mesmo em teste e em produção. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semente numérica a partir de um id (UUID ou slug). */
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
