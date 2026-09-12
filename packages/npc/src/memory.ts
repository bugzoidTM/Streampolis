import { pool } from './db.js';

/**
 * Memória do personagem, em duas camadas:
 *
 *   - episódica (`npc_memory`): o que aconteceu, na ordem. É a matéria-prima
 *     do diário e o que o painel mostra quando alguém pergunta "por que ele
 *     disse isso?";
 *   - pessoas (`npc_people`): uma linha por quem ele já viu, com as poucas
 *     anotações que fez. É o que faz "oi de novo, Ana" existir.
 *
 * Nada aqui é vetor nem embedding. Nesta fase o que interessa é o que a sala
 * acabou de dizer e o que ele sabe DESTA pessoa — as duas consultas são por
 * índice, e cabem no prompt.
 */

export type MemoryKind = 'heard' | 'said' | 'met' | 'event';

export interface Memory {
  id: number;
  kind: MemoryKind;
  userId: string | null;
  userName: string | null;
  text: string;
  createdAt: Date;
}

export interface Person {
  userId: string;
  userName: string;
  firstSeen: Date;
  lastSeen: Date;
  encounters: number;
  exchanges: number;
  notes: string[];
}

const MAX_NOTES = 8;
const MAX_TEXT = 400;

export async function remember(npcId: string, input: {
  kind: MemoryKind;
  userId?: string | null;
  userName?: string | null;
  text: string;
  roomId?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO npc_memory (npc_id, kind, user_id, user_name, text, room_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [npcId, input.kind, input.userId ?? null, input.userName ?? null, input.text.slice(0, MAX_TEXT), input.roomId ?? null],
  );
}

/** As últimas N lembranças, mais antigas primeiro (ordem de leitura). */
export async function recent(npcId: string, limit: number): Promise<Memory[]> {
  const { rows } = await pool.query<{
    id: string; kind: MemoryKind; user_id: string | null; user_name: string | null; text: string; created_at: Date;
  }>(
    `SELECT id, kind, user_id, user_name, text, created_at FROM npc_memory
      WHERE npc_id = $1 ORDER BY id DESC LIMIT $2`,
    [npcId, limit],
  );
  return rows.reverse().map((r) => ({
    id: Number(r.id), kind: r.kind, userId: r.user_id, userName: r.user_name, text: r.text, createdAt: r.created_at,
  }));
}

/** O que ele e ESTA pessoa já trocaram (falas dos dois), mais antigas primeiro. */
export async function recentWith(npcId: string, userId: string, limit: number): Promise<Memory[]> {
  const { rows } = await pool.query<{
    id: string; kind: MemoryKind; user_id: string | null; user_name: string | null; text: string; created_at: Date;
  }>(
    `SELECT id, kind, user_id, user_name, text, created_at FROM npc_memory
      WHERE npc_id = $1 AND user_id = $2 AND kind IN ('heard', 'said')
      ORDER BY id DESC LIMIT $3`,
    [npcId, userId, limit],
  );
  return rows.reverse().map((r) => ({
    id: Number(r.id), kind: r.kind, userId: r.user_id, userName: r.user_name, text: r.text, createdAt: r.created_at,
  }));
}

/** Lembranças ainda não digeridas por um diário. */
export async function unreflected(npcId: string, limit: number): Promise<Memory[]> {
  const { rows } = await pool.query<{
    id: string; kind: MemoryKind; user_id: string | null; user_name: string | null; text: string; created_at: Date;
  }>(
    `SELECT id, kind, user_id, user_name, text, created_at FROM npc_memory
      WHERE npc_id = $1 AND reflected = FALSE ORDER BY id ASC LIMIT $2`,
    [npcId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind, userId: r.user_id, userName: r.user_name, text: r.text, createdAt: r.created_at,
  }));
}

export async function markReflected(npcId: string, upToId: number): Promise<void> {
  await pool.query(
    `UPDATE npc_memory SET reflected = TRUE WHERE npc_id = $1 AND reflected = FALSE AND id <= $2`,
    [npcId, upToId],
  );
}

export async function person(npcId: string, userId: string): Promise<Person | null> {
  const { rows } = await pool.query<{
    user_id: string; user_name: string; first_seen: Date; last_seen: Date; encounters: number; exchanges: number; notes: string[];
  }>(
    `SELECT user_id, user_name, first_seen, last_seen, encounters, exchanges, notes
       FROM npc_people WHERE npc_id = $1 AND user_id = $2`,
    [npcId, userId],
  );
  const r = rows[0];
  return r ? {
    userId: r.user_id, userName: r.user_name, firstSeen: r.first_seen, lastSeen: r.last_seen,
    encounters: r.encounters, exchanges: r.exchanges, notes: r.notes,
  } : null;
}

/**
 * Viu a pessoa. Conta um ENCONTRO por visita — não por tique: a sala manda a
 * posição 20 vezes por segundo e "encontros: 40.000" não diz nada.
 */
export async function meet(npcId: string, userId: string, userName: string): Promise<Person> {
  const { rows } = await pool.query<{
    user_id: string; user_name: string; first_seen: Date; last_seen: Date; encounters: number; exchanges: number; notes: string[];
  }>(
    `INSERT INTO npc_people (npc_id, user_id, user_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (npc_id, user_id) DO UPDATE
       SET user_name = EXCLUDED.user_name,
           last_seen = now(),
           encounters = npc_people.encounters + 1
     RETURNING user_id, user_name, first_seen, last_seen, encounters, exchanges, notes`,
    [npcId, userId, userName.slice(0, 64)],
  );
  const r = rows[0]!;
  return {
    userId: r.user_id, userName: r.user_name, firstSeen: r.first_seen, lastSeen: r.last_seen,
    encounters: r.encounters, exchanges: r.exchanges, notes: r.notes,
  };
}

/** Uma troca de falas com a pessoa, e (talvez) uma anotação nova sobre ela. */
export async function exchanged(npcId: string, userId: string, userName: string, note: string | null): Promise<void> {
  const clean = note ? note.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
  await pool.query(
    `INSERT INTO npc_people (npc_id, user_id, user_name, exchanges, notes)
     VALUES ($1, $2, $3, 1, CASE WHEN $4 = '' THEN '{}'::text[] ELSE ARRAY[$4::text] END)
     ON CONFLICT (npc_id, user_id) DO UPDATE
       SET user_name = EXCLUDED.user_name,
           last_seen = now(),
           exchanges = npc_people.exchanges + 1,
           notes = CASE
             WHEN $4 = '' OR $4 = ANY(npc_people.notes) THEN npc_people.notes
             ELSE (array_append(npc_people.notes, $4::text))[greatest(1, array_length(npc_people.notes, 1) + 2 - $5):]
           END`,
    [npcId, userId, userName.slice(0, 64), clean, MAX_NOTES],
  );
}

/** Quantas trocas houve desde um instante — o gatilho da reflexão. */
export async function exchangesSince(npcId: string, since: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM npc_memory
      WHERE npc_id = $1 AND kind = 'said' AND created_at > $2`,
    [npcId, since],
  );
  return Number(rows[0]?.n ?? 0);
}
