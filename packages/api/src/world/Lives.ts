import { pool } from '../db/pool.ts';
import { EconomyError } from '../economy/errors.ts';

/**
 * Sessões de live (PRD §10, SPECs §17).
 *
 * O game server abre e fecha a sessão; o host é sempre a identidade
 * autenticada que ele passa, nunca um id vindo do navegador. O índice único
 * `stream_sessions_one_live_per_host` garante no BANCO o que a sala garante em
 * memória: um host, uma live.
 */

export interface OpenLiveInput {
  /** Id gerado pelo game server; torna a abertura idempotente num retry. */
  externalId: string;
  hostId: string;
  title: string;
  category: string;
  roomId: string;
}

export interface LiveRecord {
  liveId: string;
  externalId: string;
  hostId: string;
  replayed: boolean;
}

export async function openLive(input: OpenLiveInput): Promise<LiveRecord> {
  const title = input.title.trim().slice(0, 80) || 'Live';

  const existing = await pool.query<{ id: string; host_id: string }>(
    'SELECT id, host_id FROM stream_sessions WHERE external_id = $1',
    [input.externalId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.host_id !== input.hostId) {
      // Mesmo id externo com outro host: ou colisão de id, ou tentativa de
      // sequestrar a sessão de alguém. Nos dois casos, recusa.
      throw new EconomyError('IDEMPOTENCY_CONFLICT', 'Sessão já pertence a outro host.', 409);
    }
    return { liveId: row.id, externalId: input.externalId, hostId: row.host_id, replayed: true };
  }

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO stream_sessions (external_id, host_id, title, category, room_id, status)
       VALUES ($1,$2,$3,$4,$5,'live') RETURNING id`,
      [input.externalId, input.hostId, title, input.category || 'geral', input.roomId],
    );
    return { liveId: rows[0].id, externalId: input.externalId, hostId: input.hostId, replayed: false };
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { constraint?: string }).constraint === 'stream_sessions_one_live_per_host') {
      throw new EconomyError('IDEMPOTENCY_CONFLICT', 'Este host já está ao vivo.', 409);
    }
    throw err;
  }
}

export interface CloseLiveInput {
  externalId: string;
  hostId: string;
  peakViewers: number;
  uniqueViewers: number;
  likes: number;
}

export async function closeLive(input: CloseLiveInput): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE stream_sessions
        SET status = 'ended', ended_at = now(),
            peak_real_viewers = GREATEST(peak_real_viewers, $3),
            unique_viewers = GREATEST(unique_viewers, $4),
            likes = GREATEST(likes, $5)
      WHERE external_id = $1 AND host_id = $2 AND status = 'live'`,
    [
      input.externalId,
      input.hostId,
      Math.max(0, Math.trunc(input.peakViewers)),
      Math.max(0, Math.trunc(input.uniqueViewers)),
      Math.max(0, Math.trunc(input.likes)),
    ],
  );
  return (rowCount ?? 0) > 0;
}

export interface LiveListing {
  liveId: string;
  externalId: string | null;
  /**
   * Sala do game server. É a CHAVE DE ENTRADA do espectador — sem ela o feed
   * lista lives que ninguém consegue assistir.
   */
  roomId: string | null;
  hostId: string;
  hostName: string;
  /**
   * Aparência do host. O feed desenha o avatar de verdade na capa do card —
   * sem isso a única alternativa é uma imagem genérica, e o feed de um jogo
   * sobre criadores não pode mostrar todo mundo igual.
   */
  hostAvatar: unknown;
  title: string;
  category: string;
  likes: number;
  startedAt: Date;
}

/** Feed (PRD §11). Sem contagem inflada: `stream_viewers` é quem entrou mesmo. */
export async function listLives(limit = 50): Promise<LiveListing[]> {
  const { rows } = await pool.query<{
    id: string; external_id: string | null; room_id: string | null; host_id: string;
    title: string; category: string; likes: number; started_at: Date;
    display_name: string | null; username: string; config: unknown;
  }>(
    `SELECT s.id, s.external_id, s.room_id, s.host_id, s.title, s.category, s.likes, s.started_at,
            p.display_name, u.username, av.config
       FROM stream_sessions s
       JOIN users u ON u.id = s.host_id
       LEFT JOIN profiles p ON p.user_id = s.host_id
       LEFT JOIN avatars av ON av.user_id = s.host_id
      WHERE s.status = 'live'
      ORDER BY s.started_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((r) => ({
    liveId: r.id,
    externalId: r.external_id,
    roomId: r.room_id,
    hostId: r.host_id,
    hostName: r.display_name || r.username,
    hostAvatar: r.config ?? null,
    title: r.title,
    category: r.category,
    likes: r.likes,
    startedAt: r.started_at,
  }));
}
