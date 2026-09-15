import { pool } from './db.js';
import type { WorldSnapshot } from './fatigue.js';
import { warn } from './log.js';

/**
 * O registro das intenções do personagem cognitivo (`npc_intentions`): o que
 * ele decidiu fazer, por quê, por quanto tempo, e deu em quê. É lido pela
 * próxima deliberação ("o que você já tentou e rendeu conversa") e pelo
 * painel. Escrita mínima: uma linha ao começar, um UPDATE ao terminar.
 */
export type IntentionSource = 'deliberation' | 'conversation' | 'default';
export type IntentionOutcome = 'done' | 'expired' | 'failed' | 'replaced' | 'interrupted';

/** Gente de verdade que cruzou a intenção (nomes, poucos; NPC não conta). */
export interface IntentionInteractions {
  /** Trocas de conversa (ele respondeu a alguém). */
  exchanges: number;
  /** Cumprimentos que ele fez. */
  greetings: number;
  /** Falas de gente por perto, dirigidas a ele ou não. */
  heard: number;
  spokeWith: string[];
  /** Quem chegou a ficar a poucos metros dele. */
  nearby: string[];
  /** Quantas vezes chegou a um destino (patrol e visit_poi chegam a vários). */
  arrivals: number;
}

/** Algo que aconteceu no mundo durante a intenção: aos `t` segundos do início. */
export interface IntentionEvent {
  t: number;
  what: string;
}

/** O resultado de uma intenção, em partes (migration 0028). */
export interface IntentionResult {
  outcome: IntentionOutcome;
  /** Chegou ao destino? Nulo quando a habilidade não tem destino. */
  arrived: boolean | null;
  arriveSec: number | null;
  dwellSec: number | null;
  interactions: IntentionInteractions;
  events: IntentionEvent[];
}

/** O que o "why" afirmou sem dado observado correspondente (`grounding.ts`). */
export interface WhyAudit {
  unsupported: string[];
}

export const EMPTY_INTERACTIONS: IntentionInteractions = { exchanges: 0, greetings: 0, heard: 0, spokeWith: [], nearby: [], arrivals: 0 };

export interface IntentionRow {
  id: number;
  goal: string;
  why: string | null;
  skill: string;
  params: Record<string, unknown>;
  source: IntentionSource;
  outcome: IntentionOutcome | null;
  exchanges: number;
  startedAt: Date;
  endedAt: Date | null;
  /** O mundo quando começou (clima, noite, quem estava): a fadiga compara com o de agora. */
  world: WorldSnapshot | null;
  arrived: boolean | null;
  arriveSec: number | null;
  dwellSec: number | null;
  /** Nulo nas linhas de antes da migration 0028 (ou ainda em curso). */
  interactions: IntentionInteractions | null;
  events: IntentionEvent[] | null;
  whyAudit: WhyAudit | null;
}

export async function beginIntention(npcId: string, input: {
  goal: string; why: string | null; skill: string; params: Record<string, unknown>;
  source: IntentionSource; trigger: string | null; plannedMin: number; roomId: string | null; world: WorldSnapshot | null;
  whyAudit?: WhyAudit | null;
}): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO npc_intentions (npc_id, goal, why, skill, params, source, trigger, planned_min, room_id, world, why_audit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [npcId, input.goal.slice(0, 200), input.why?.slice(0, 300) ?? null, input.skill, JSON.stringify(input.params),
        input.source, input.trigger?.slice(0, 120) ?? null, input.plannedMin, input.roomId, input.world ? JSON.stringify(input.world) : null,
        input.whyAudit?.unsupported.length ? JSON.stringify(input.whyAudit) : null],
    );
    return Number(rows[0]!.id);
  } catch (err) {
    warn('intent', 'não registrou', { err: String(err) });
    return null;
  }
}

/** Encerra com o resultado em partes; `exchanges` continua na coluna própria (o soak e a experiência somam por ela). */
export async function endIntention(id: number, result: IntentionResult): Promise<void> {
  try {
    await pool.query(
      `UPDATE npc_intentions
          SET ended_at = now(), outcome = $2, exchanges = $3, arrived = $4, arrive_sec = $5, dwell_sec = $6, interactions = $7, events = $8
        WHERE id = $1 AND ended_at IS NULL`,
      [id, result.outcome, result.interactions.exchanges, result.arrived, result.arriveSec, result.dwellSec,
        JSON.stringify(result.interactions), JSON.stringify(result.events.slice(0, 40))],
    );
  } catch (err) {
    warn('intent', 'não encerrou', { err: String(err) });
  }
}

/**
 * Fecha o que ficou aberto de outra vida do processo. Uma intenção só corre
 * na memória de quem a começou: depois de um reinício (ou de um INSERT que
 * voltou tarde demais para o encerramento alcançá-lo) uma linha com
 * `ended_at` nulo é órfã, e órfã vira 'interrupted'. Devolve quantas fechou.
 */
export async function closeOrphanIntentions(npcId: string): Promise<number> {
  try {
    const { rowCount } = await pool.query(
      `UPDATE npc_intentions SET ended_at = now(), outcome = 'interrupted' WHERE npc_id = $1 AND ended_at IS NULL`,
      [npcId],
    );
    return rowCount ?? 0;
  } catch (err) {
    warn('intent', 'não fechou órfãs', { err: String(err) });
    return 0;
  }
}

/** As últimas intenções, mais recentes primeiro. */
export async function recentIntentions(npcId: string, limit: number): Promise<IntentionRow[]> {
  const { rows } = await pool.query<{
    id: string; goal: string; why: string | null; skill: string; params: Record<string, unknown>; source: IntentionSource;
    outcome: IntentionOutcome | null; exchanges: number; started_at: Date; ended_at: Date | null; world: WorldSnapshot | null;
    arrived: boolean | null; arrive_sec: number | null; dwell_sec: number | null;
    interactions: IntentionInteractions | null; events: IntentionEvent[] | null; why_audit: WhyAudit | null;
  }>(
    `SELECT id, goal, why, skill, params, source, outcome, exchanges, started_at, ended_at, world,
            arrived, arrive_sec, dwell_sec, interactions, events, why_audit
       FROM npc_intentions WHERE npc_id = $1 ORDER BY id DESC LIMIT $2`,
    [npcId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), goal: r.goal, why: r.why, skill: r.skill, params: r.params ?? {}, source: r.source,
    outcome: r.outcome, exchanges: r.exchanges, startedAt: r.started_at, endedAt: r.ended_at, world: r.world ?? null,
    arrived: r.arrived, arriveSec: r.arrive_sec, dwellSec: r.dwell_sec,
    interactions: r.interactions ?? null, events: r.events ?? null, whyAudit: r.why_audit ?? null,
  }));
}

/** Por habilidade, nos últimos 7 dias: quantas vezes, quantas conversas renderam. A "experiência" do personagem. */
export async function skillExperience(npcId: string): Promise<Array<{ skill: string; times: number; exchanges: number; failed: number }>> {
  const { rows } = await pool.query<{ skill: string; times: string; exchanges: string; failed: string }>(
    `SELECT skill, count(*)::text AS times, coalesce(sum(exchanges), 0)::text AS exchanges,
            count(*) FILTER (WHERE outcome = 'failed')::text AS failed
       FROM npc_intentions
      WHERE npc_id = $1 AND started_at > now() - interval '7 days' AND source = 'deliberation'
      GROUP BY skill ORDER BY count(*) DESC`,
    [npcId],
  );
  return rows.map((r) => ({ skill: r.skill, times: Number(r.times), exchanges: Number(r.exchanges), failed: Number(r.failed) }));
}
