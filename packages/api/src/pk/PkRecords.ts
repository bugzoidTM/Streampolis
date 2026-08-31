import type { PoolClient } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';
import { EconomyError } from '../economy/errors.ts';

/**
 * Persistência de PK (SPECs §33).
 *
 * Divisão de autoridade, decidida de uma vez:
 *
 *   Game Server  = autoridade do placar. Tem o relógio, as fases, a ordem dos
 *                  gifts validados e é quem declara o vencedor.
 *   API          = memória. Grava o resultado apurado, atualiza fama e histórico.
 *
 * Nada aqui recalcula quem ganhou. Se a API discordasse do servidor, existiriam
 * dois vencedores para a mesma batalha — e o jogador veria um na tela e outro
 * no perfil.
 *
 * A gravação é idempotente pelo id da batalha: o servidor pode reenviar o
 * resultado à vontade (retry de rede, restart) sem duplicar fama.
 */

export interface PKResultInput {
  /** Id da batalha gerado pelo game server. */
  battleId: string;
  hostA: string;
  hostB: string;
  scoreA: number;
  scoreB: number;
  draw: boolean;
  /** Vazio em empate. */
  winnerId: string;
  /** Sessão de live onde a batalha aconteceu, quando houver. */
  streamId?: string | null;
  startedAt?: Date | null;
  finishedAt: Date;
}

export interface PKResultRecord {
  matchId: string;
  replayed: boolean;
  winnerId: string | null;
  resultKind: 'a' | 'b' | 'draw';
}

/** Fama por vitória de PK (PRD §22). Empate não distribui nada. */
const FAME_PER_WIN = 250;

function validate(input: PKResultInput): 'a' | 'b' | 'draw' {
  if (!input.battleId) throw new EconomyError('INVALID_AMOUNT', 'battleId ausente.', 400);
  if (input.hostA === input.hostB) {
    throw new EconomyError('INVALID_AMOUNT', 'Uma batalha precisa de dois hosts distintos.', 400);
  }
  for (const score of [input.scoreA, input.scoreB]) {
    if (!Number.isSafeInteger(score) || score < 0) {
      throw new EconomyError('INVALID_AMOUNT', 'Placar inválido.', 400);
    }
  }
  if (input.draw) {
    if (input.winnerId) {
      throw new EconomyError('INVALID_AMOUNT', 'Empate não tem vencedor.', 400);
    }
    return 'draw';
  }
  if (input.winnerId !== input.hostA && input.winnerId !== input.hostB) {
    throw new EconomyError('INVALID_AMOUNT', 'Vencedor não participou da batalha.', 400);
  }
  // O placar tem que sustentar o vencedor declarado. Não é recalcular o
  // resultado: é recusar um payload internamente contraditório, que só pode ser
  // bug do servidor ou chamada forjada.
  const leader = input.scoreA > input.scoreB ? input.hostA : input.hostB;
  if (input.scoreA === input.scoreB || leader !== input.winnerId) {
    throw new EconomyError('INVALID_AMOUNT', 'Vencedor não bate com o placar.', 400);
  }
  return input.winnerId === input.hostA ? 'a' : 'b';
}

async function existing(client: PoolClient, battleId: string): Promise<PKResultRecord | null> {
  const { rows } = await client.query<{
    id: string; winner_id: string | null; result_kind: 'a' | 'b' | 'draw' | null;
  }>(
    `SELECT id, winner_id, result_kind FROM pk_matches
      WHERE external_id = $1 AND status = 'FINISHED'`,
    [battleId],
  );
  const row = rows[0];
  if (!row || !row.result_kind) return null;
  return { matchId: row.id, replayed: true, winnerId: row.winner_id, resultKind: row.result_kind };
}

/**
 * Grava o resultado final de uma batalha. Chamada pelo game server através de
 * POST /internal/pk/result, com o token de serviço.
 */
export async function recordPKResult(input: PKResultInput): Promise<PKResultRecord> {
  const resultKind = validate(input);

  return withTransaction(async (client) => {
    const already = await existing(client, input.battleId);
    if (already) return already;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO pk_matches
         (external_id, host_a, host_b, stream_id, status, score_a, score_b,
          started_at, ended_at, winner_id, result_kind)
       VALUES ($1,$2,$3,$4,'FINISHED',$5,$6,$7,$8,$9,$10)
       -- O índice de external_id é PARCIAL (só linhas não nulas), então o
       -- predicado tem que aparecer aqui: sem ele o Postgres não consegue
       -- inferir o índice e recusa o ON CONFLICT inteiro.
       ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE
         SET score_a = EXCLUDED.score_a,
             score_b = EXCLUDED.score_b,
             status = 'FINISHED',
             ended_at = EXCLUDED.ended_at,
             winner_id = EXCLUDED.winner_id,
             result_kind = EXCLUDED.result_kind
       RETURNING id`,
      [
        input.battleId,
        input.hostA,
        input.hostB,
        input.streamId ?? null,
        input.scoreA,
        input.scoreB,
        input.startedAt ?? null,
        input.finishedAt,
        input.draw ? null : input.winnerId,
        resultKind,
      ],
    );
    const matchId = rows[0].id;

    if (!input.draw) {
      await client.query(
        `UPDATE player_stats SET fame = fame + $2, updated_at = now() WHERE user_id = $1`,
        [input.winnerId, FAME_PER_WIN],
      );
    }

    return { matchId, replayed: false, winnerId: input.draw ? null : input.winnerId, resultKind };
  });
}

/** Histórico de PK de um usuário, mais recente primeiro (PRD §21). */
export async function listPKHistory(userId: string, limit = 20): Promise<Array<{
  matchId: string;
  opponentId: string;
  scoreFor: number;
  scoreAgainst: number;
  won: boolean;
  draw: boolean;
  finishedAt: Date;
}>> {
  const { rows } = await withTransaction(async (client) =>
    client.query<{
      id: string; host_a: string; host_b: string; score_a: number; score_b: number;
      winner_id: string | null; result_kind: 'a' | 'b' | 'draw'; ended_at: Date;
    }>(
      `SELECT id, host_a, host_b, score_a, score_b, winner_id, result_kind, ended_at
         FROM pk_matches
        WHERE status = 'FINISHED' AND (host_a = $1 OR host_b = $1)
        ORDER BY ended_at DESC
        LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    ),
  );

  return rows.map((r) => {
    const isA = r.host_a === userId;
    return {
      matchId: r.id,
      opponentId: isA ? r.host_b : r.host_a,
      scoreFor: isA ? r.score_a : r.score_b,
      scoreAgainst: isA ? r.score_b : r.score_a,
      won: r.winner_id === userId,
      draw: r.result_kind === 'draw',
      finishedAt: r.ended_at,
    };
  });
}
