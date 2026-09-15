import { pool } from './db.js';
import { warn } from './log.js';

/**
 * O registro das intenções do personagem cognitivo (`npc_intentions`): o que
 * ele decidiu fazer, por quê, por quanto tempo, e deu em quê. É lido pela
 * próxima deliberação ("o que você já tentou e rendeu conversa") e pelo
 * painel. Escrita mínima: uma linha ao começar, um UPDATE ao terminar.
 */
export type IntentionSource = 'deliberation' | 'conversation' | 'default';
export type IntentionOutcome = 'done' | 'expired' | 'failed' | 'replaced' | 'interrupted';

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
}

export async function beginIntention(npcId: string, input: {
  goal: string; why: string | null; skill: string; params: Record<string, unknown>;
  source: IntentionSource; trigger: string | null; plannedMin: number; roomId: string | null;
}): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO npc_intentions (npc_id, goal, why, skill, params, source, trigger, planned_min, room_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [npcId, input.goal.slice(0, 200), input.why?.slice(0, 300) ?? null, input.skill, JSON.stringify(input.params),
        input.source, input.trigger?.slice(0, 120) ?? null, input.plannedMin, input.roomId],
    );
    return Number(rows[0]!.id);
  } catch (err) {
    warn('intent', 'não registrou', { err: String(err) });
    return null;
  }
}

export async function endIntention(id: number, outcome: IntentionOutcome, exchanges: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE npc_intentions SET ended_at = now(), outcome = $2, exchanges = $3 WHERE id = $1 AND ended_at IS NULL`,
      [id, outcome, exchanges],
    );
  } catch (err) {
    warn('intent', 'não encerrou', { err: String(err) });
  }
}

/** As últimas intenções, mais recentes primeiro. */
export async function recentIntentions(npcId: string, limit: number): Promise<IntentionRow[]> {
  const { rows } = await pool.query<{
    id: string; goal: string; why: string | null; skill: string; params: Record<string, unknown>; source: IntentionSource;
    outcome: IntentionOutcome | null; exchanges: number; started_at: Date; ended_at: Date | null;
  }>(
    `SELECT id, goal, why, skill, params, source, outcome, exchanges, started_at, ended_at
       FROM npc_intentions WHERE npc_id = $1 ORDER BY id DESC LIMIT $2`,
    [npcId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), goal: r.goal, why: r.why, skill: r.skill, params: r.params ?? {}, source: r.source,
    outcome: r.outcome, exchanges: r.exchanges, startedAt: r.started_at, endedAt: r.ended_at,
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
