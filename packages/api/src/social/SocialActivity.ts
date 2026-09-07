import { pool } from '../db/pool.ts';
import { config } from '../config.ts';

/**
 * A North Star do produto (PRD §31, §32).
 *
 * "A principal métrica não será dinheiro gasto. Será **Weekly Socially Active
 * Players**: jogadores que, durante a semana, realizaram ao menos uma interação
 * significativa com outro jogador."
 *
 * Este arquivo existe porque uma beta pública que não sabe responder isso não
 * aprende nada com estar no ar. Dá para contar cadastros e vendas por SQL a
 * qualquer momento; o que não dava para saber é se o lugar está funcionando
 * como MUNDO SOCIAL, que é a tese inteira do produto.
 *
 * ## Uma linha por pessoa, por dia, por tipo
 *
 * Chat de mil mensagens vira UMA linha. É o menor registro que responde à
 * pergunta, e é o que torna a escrita desprezível no caminho quente: o chat da
 * praça não pode pagar um INSERT por mensagem para alimentar um gráfico.
 *
 * ## O dia é o do JOGADOR
 *
 * O corte usa o fuso de `RANKINGS_TIMEZONE` (América/São_Paulo), pelo mesmo
 * motivo dos rankings: em UTC, "hoje" acabaria às 21h de Brasília, no meio do
 * horário de maior audiência. Métrica com dia errado é pior que métrica
 * nenhuma, porque parece certa.
 */

export const SOCIAL_KINDS = [
  'live', 'chat', 'follow', 'friendship', 'gift', 'pk', 'visit', 'agency',
] as const;

export type SocialKind = (typeof SOCIAL_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(SOCIAL_KINDS);

export function isSocialKind(value: unknown): value is SocialKind {
  return typeof value === 'string' && KIND_SET.has(value);
}

/**
 * Marca a interação. **Nunca lança** e nunca é esperado no caminho crítico: um
 * gráfico não pode derrubar um gift. Chamado com `void`.
 */
export async function markSocial(userId: string, kind: SocialKind): Promise<void> {
  if (!userId || !isSocialKind(kind)) return;
  try {
    await pool.query(
      `INSERT INTO social_activity (user_id, day, kind)
       VALUES ($1, (now() AT TIME ZONE $3)::date, $2)
       ON CONFLICT (user_id, day, kind) DO NOTHING`,
      [userId, kind, config.rankingsTimezone],
    );
  } catch {
    // Métrica perdida é métrica perdida. O jogo segue.
  }
}

/** Vários de uma vez, do batimento do game server. */
export async function markSocialBatch(
  entries: Array<{ userId: string; kind: SocialKind }>,
): Promise<number> {
  const validas = entries.filter((e) => e.userId && isSocialKind(e.kind)).slice(0, 500);
  if (validas.length === 0) return 0;
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO social_activity (user_id, day, kind)
       SELECT u.id, (now() AT TIME ZONE $3)::date, v.kind
         FROM unnest($1::uuid[], $2::text[]) AS v(user_id, kind)
         JOIN users u ON u.id = v.user_id
       ON CONFLICT (user_id, day, kind) DO NOTHING`,
      [validas.map((e) => e.userId), validas.map((e) => e.kind), config.rankingsTimezone],
    );
    return rowCount ?? 0;
  } catch {
    return 0;
  }
}

export interface ProductMetrics {
  window: { days: number; from: string; to: string };
  /** §32: a única métrica que o produto chama de principal. */
  weeklySociallyActivePlayers: number;
  /** Quantas pessoas tiveram CADA tipo de interação na janela. */
  socialByKind: Record<string, number>;
  activePlayers: { daily: number; window: number };
  accounts: { total: number; newInWindow: number };
  world: {
    livesStarted: number;
    pkMatches: number;
    giftsSent: number;
    followsMade: number;
    friendshipsFormed: number;
  };
  economy: {
    coinsSold: number;
    coinsSpent: number;
    payingPlayers: number;
    /** §31: "conversão para comprador" — de quem se cadastrou, quem pagou. */
    buyerConversion: number;
    /** §31: ARPPU em centavos, para não inventar arredondamento de moeda. */
    arppuCents: number;
  };
}

/**
 * O painel de produto (§31).
 *
 * Tudo numa janela só e em UMA chamada: números que exigem abrir seis telas não
 * são olhados, e métrica não olhada não muda decisão nenhuma.
 */
export async function productMetrics(days = 7): Promise<ProductMetrics> {
  const janela = Math.min(Math.max(Math.trunc(days), 1), 90);
  const tz = config.rankingsTimezone;

  const [social, ativos, contas, mundo, economia] = await Promise.all([
    pool.query(
      `SELECT kind, count(DISTINCT user_id) AS pessoas
         FROM social_activity
        WHERE day > (now() AT TIME ZONE $2)::date - $1::int
        GROUP BY kind`,
      [janela, tz],
    ),
    pool.query(
      `SELECT
         count(DISTINCT user_id) FILTER (WHERE day = (now() AT TIME ZONE $2)::date) AS hoje,
         count(DISTINCT user_id) AS janela
       FROM social_activity
       WHERE day > (now() AT TIME ZONE $2)::date - $1::int`,
      [janela, tz],
    ),
    pool.query(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE created_at > now() - make_interval(days => $1)) AS novas
         FROM users WHERE role = 'player' AND status <> 'deleted'`,
      [janela],
    ),
    pool.query(
      `SELECT
         (SELECT count(*) FROM stream_sessions WHERE started_at > now() - make_interval(days => $1)) AS lives,
         (SELECT count(*) FROM pk_matches WHERE created_at > now() - make_interval(days => $1)) AS pks,
         (SELECT count(*) FROM gift_events WHERE created_at > now() - make_interval(days => $1)) AS gifts,
         (SELECT count(*) FROM follows WHERE created_at > now() - make_interval(days => $1)) AS follows,
         (SELECT count(*) FROM friendships
           WHERE status = 'accepted' AND updated_at > now() - make_interval(days => $1)) AS amizades`,
      [janela],
    ),
    pool.query(
      `SELECT
         (SELECT coalesce(sum(coins), 0) FROM payments
           WHERE status = 'paid' AND paid_at > now() - make_interval(days => $1)) AS coins_vendidos,
         (SELECT coalesce(sum(amount_cents), 0) FROM payments
           WHERE status = 'paid' AND paid_at > now() - make_interval(days => $1)) AS centavos,
         (SELECT count(DISTINCT user_id) FROM payments
           WHERE status = 'paid' AND paid_at > now() - make_interval(days => $1)) AS pagantes,
         (SELECT coalesce(-sum(amount), 0) FROM wallet_transactions
           WHERE currency = 'coins' AND amount < 0
             AND created_at > now() - make_interval(days => $1)) AS coins_gastos,
         (SELECT count(*) FROM users WHERE role = 'player' AND status <> 'deleted') AS jogadores`,
      [janela],
    ),
  ]);

  const porTipo: Record<string, number> = {};
  for (const linha of social.rows) porTipo[linha.kind] = Number(linha.pessoas);

  const pagantes = Number(economia.rows[0].pagantes);
  const jogadores = Number(economia.rows[0].jogadores) || 1;
  const centavos = Number(economia.rows[0].centavos);

  return {
    window: {
      days: janela,
      from: new Date(Date.now() - janela * 86_400_000).toISOString(),
      to: new Date().toISOString(),
    },
    // A North Star conta PESSOAS, não interações: quem falou mil vezes com a
    // mesma pessoa conta uma vez, e é isso que o §32 quer saber.
    weeklySociallyActivePlayers: Number(ativos.rows[0].janela),
    socialByKind: porTipo,
    activePlayers: {
      daily: Number(ativos.rows[0].hoje),
      window: Number(ativos.rows[0].janela),
    },
    accounts: {
      total: Number(contas.rows[0].total),
      newInWindow: Number(contas.rows[0].novas),
    },
    world: {
      livesStarted: Number(mundo.rows[0].lives),
      pkMatches: Number(mundo.rows[0].pks),
      giftsSent: Number(mundo.rows[0].gifts),
      followsMade: Number(mundo.rows[0].follows),
      friendshipsFormed: Number(mundo.rows[0].amizades),
    },
    economy: {
      coinsSold: Number(economia.rows[0].coins_vendidos),
      coinsSpent: Number(economia.rows[0].coins_gastos),
      payingPlayers: pagantes,
      buyerConversion: Math.round((pagantes / jogadores) * 10_000) / 10_000,
      arppuCents: pagantes > 0 ? Math.round(centavos / pagantes) : 0,
    },
  };
}
