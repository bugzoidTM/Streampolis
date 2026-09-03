import type { SceneId } from './types.js';

/**
 * Presença efêmera: ONDE um jogador está agora (SPECs §17).
 *
 * Não é identidade e não é histórico — é o único dado do jogo que fica
 * inteiramente na memória de processos que podem morrer a qualquer momento, e
 * isso é a definição correta e não uma economia: se o game server cai, ninguém
 * está mais em sala nenhuma. Persistir presença é como guardar num banco a
 * posição do ponteiro do mouse.
 *
 * O que ela responde, e nada além disso:
 *
 *     userId → sceneId → roomId
 *
 * O `roomId` é o que faltava. A cena já se sabia pelo perfil ("está no mundo"),
 * mas com a praça shardada saber a cena não leva ninguém a lugar nenhum: são
 * três praças centrais ao mesmo tempo, e entrar "na praça" é entrar em qualquer
 * uma delas. Encontrar alguém exige o shard.
 */

/**
 * Estado grosso, o mesmo vocabulário do CHECK de `profiles.presence` na
 * migração 0001 — de propósito: se um dia a presença virar coluna, ela cabe
 * sem conversão. `offline` e `online` não aparecem aqui porque não são sala:
 * offline é a AUSÊNCIA de registro, e é assim que o diretório a representa.
 */
export type PresenceKind = 'in_world' | 'watching_live' | 'streaming' | 'in_pk';

/** Onde um jogador está. Um jogador tem no máximo uma destas por vez. */
export interface PresenceEntry {
  userId: string;
  sceneId: SceneId;
  /** Shard exato. Sem ele, "está na praça" não é um endereço (§17). */
  roomId: string;
  kind: PresenceKind;
  /** Epoch ms de quando entrou NESTA sala; troca de sala reinicia. */
  since: number;
}

/**
 * O que um processo de game server declara sobre si.
 *
 * É sempre o retrato COMPLETO daquele processo, nunca um delta. Delta obriga
 * os dois lados a concordarem sobre o passado — uma mensagem perdida e o
 * diretório fica com um fantasma para sempre. O retrato completo é idempotente:
 * chegou, a fatia daquele servidor é substituída inteira; não chegou mais
 * nenhum, a fatia expira sozinha por TTL.
 */
export interface PresenceSnapshot {
  /** Identidade do PROCESSO, não da sala: um servidor, muitas salas. */
  serverId: string;
  /** Quando o retrato foi tirado (epoch ms), pelo relógio de quem tirou. */
  at: number;
  entries: PresenceEntry[];
}

/** Localização de outro jogador, como a API a devolve. */
export interface PresenceLocation extends PresenceEntry {
  serverId: string;
}
