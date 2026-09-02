import { pool } from '../db/pool.ts';
import { config } from '../config.ts';
import { DEFAULT_AVATAR_DTO, type AvatarConfigDTO } from '../auth/identity.ts';

/**
 * Rankings (PRD §23).
 *
 * Três placares e três janelas. O que decide tudo aqui é de onde o número sai:
 * **do evento datado, nunca do contador vitalício**. `player_stats.fame`,
 * `creator_points` e `gifter_xp` somam desde sempre e não sabem responder
 * "hoje" — e um ranking que só sabe responder "desde sempre" é o monumento a
 * quem chegou primeiro que a temporada existe para evitar. Quem tem data é
 * `gift_events` e `pk_matches`, e é deles que o placar é somado.
 *
 * O que cada placar mede:
 *
 * - **Streamers**: Creator Points recebidos na janela. O PRD (§14) dá a este
 *   contador o papel de ranking; ele não converte em dinheiro e por isso pode
 *   ser somado à vista sem virar tabela de saque.
 * - **Gifters**: Coins enviados na janela — a progressão de quem presenteia
 *   (§17), medida no gasto e não no saldo.
 * - **PK**: vitórias na janela, desempate pelos pontos do lado vencedor. Uma
 *   vitória apertada e uma goleada valem uma vitória cada, que é o que a
 *   disputa 1x1 do §18 premia.
 *
 * Fica de fora **Top Agencies**, o quarto do §23: agência não é requisito do
 * MVP (§30), ninguém entra em uma, e um placar com cinco linhas vazias mente
 * mais do que um placar ausente.
 */

export type RankingBoard = 'streamers' | 'gifters' | 'pk';
export type RankingRange = 'today' | 'week' | 'season';

export const RANKING_BOARDS: readonly RankingBoard[] = ['streamers', 'gifters', 'pk'];
export const RANKING_RANGES: readonly RankingRange[] = ['today', 'week', 'season'];

export interface RankingEntry {
  userId: string;
  rank: number;
  username: string;
  displayName: string;
  avatar: AvatarConfigDTO;
  /** O número do placar, na unidade de `unit`. */
  value: number;
  /** Fama vitalícia — contexto ao lado do número da janela, nunca a ordem. */
  fame: number;
  agency: string | null;
}

export interface RankingPage {
  board: RankingBoard;
  range: RankingRange;
  unit: string;
  /** Nome e fim da temporada corrente; nulo quando nenhuma está aberta. */
  season: { name: string; endsAt: string } | null;
  /** Início da janela somada, em ISO — a tela mostra "desde quando". */
  since: string | null;
  entries: RankingEntry[];
}

const UNIT: Record<RankingBoard, string> = {
  streamers: 'Creator Points',
  gifters: 'Coins enviados',
  pk: 'Vitórias',
};

export function isBoard(v: unknown): v is RankingBoard {
  return typeof v === 'string' && (RANKING_BOARDS as readonly string[]).includes(v);
}

export function isRange(v: unknown): v is RankingRange {
  return typeof v === 'string' && (RANKING_RANGES as readonly string[]).includes(v);
}

interface Row {
  user_id: string;
  username: string;
  display_name: string | null;
  config: AvatarConfigDTO | null;
  value: string | number;
  fame: string | number | null;
  agency_name: string | null;
}

const int = (v: string | number | null | undefined): number => {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

/**
 * O começo da janela.
 *
 * "Hoje" e "semana" são cortes de CALENDÁRIO no fuso do público, não "as
 * últimas 24 horas": o jogador espera que o placar de hoje zere à meia-noite
 * dele, e em UTC isso aconteceria às 21h de Brasília — no meio do horário de
 * maior audiência. `date_trunc` no fuso e a volta para timestamptz fazem esse
 * corte no banco, que é onde a comparação vai acontecer.
 *
 * "Temporada" não é um intervalo fixo: é a linha aberta em `seasons`. Sem
 * temporada aberta o placar não inventa uma janela — ele responde vazio, e a
 * tela diz que a temporada acabou.
 */
async function windowStart(
  range: RankingRange,
): Promise<{ since: string | null; season: { name: string; endsAt: string } | null }> {
  if (range === 'season') {
    const { rows } = await pool.query<{ name: string; starts_at: Date; ends_at: Date }>(
      `SELECT name, starts_at, ends_at FROM seasons
        WHERE now() >= starts_at AND now() < ends_at
        ORDER BY starts_at DESC LIMIT 1`,
    );
    const s = rows[0];
    if (!s) return { since: null, season: null };
    return {
      since: s.starts_at.toISOString(),
      season: { name: s.name, endsAt: s.ends_at.toISOString() },
    };
  }
  const unit = range === 'today' ? 'day' : 'week';
  const { rows } = await pool.query<{ since: Date }>(
    `SELECT (date_trunc($1, now() AT TIME ZONE $2) AT TIME ZONE $2) AS since`,
    [unit, config.rankingsTimezone],
  );
  return { since: rows[0].since.toISOString(), season: null };
}

/**
 * A soma de cada placar, por usuário, dentro da janela.
 *
 * Cada consulta agrega PRIMEIRO e junta os dados de pessoa depois: agregar
 * junto do `join` faria o banco varrer perfil e avatar de todo mundo que já
 * mandou um presente para descartar quase todos na ordenação.
 */
function query(board: RankingBoard): string {
  const placar = {
    streamers: `SELECT receiver_id AS user_id, sum(creator_points)::bigint AS value, 0::bigint AS tie
                  FROM gift_events WHERE created_at >= $1
                 GROUP BY receiver_id`,
    gifters: `SELECT sender_id AS user_id, sum(coin_total)::bigint AS value, 0::bigint AS tie
                FROM gift_events WHERE created_at >= $1
               GROUP BY sender_id`,
    // O vencedor é uma coluna; os pontos dele estão na coluna do LADO que
    // venceu, e é por isso que o desempate precisa do `result_kind`.
    pk: `SELECT winner_id AS user_id, count(*)::bigint AS value,
                sum(CASE result_kind WHEN 'a' THEN score_a ELSE score_b END)::bigint AS tie
           FROM pk_matches
          WHERE status = 'FINISHED' AND winner_id IS NOT NULL AND ended_at >= $1
          GROUP BY winner_id`,
  }[board];

  return `
    WITH placar AS (${placar})
    SELECT p.user_id, u.username, pr.display_name, av.config,
           p.value, st.fame, ag.name AS agency_name
      FROM placar p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN profiles pr ON pr.user_id = p.user_id
      LEFT JOIN avatars av ON av.user_id = p.user_id
      LEFT JOIN player_stats st ON st.user_id = p.user_id
      LEFT JOIN agency_members am ON am.user_id = p.user_id
      LEFT JOIN agencies ag ON ag.id = am.agency_id
     WHERE p.value > 0 AND u.status = 'active'
     ORDER BY p.value DESC, p.tie DESC, u.username ASC
     LIMIT $2`;
}

export async function getRanking(
  board: RankingBoard, range: RankingRange, limit = 20,
): Promise<RankingPage> {
  const { since, season } = await windowStart(range);
  const page: RankingPage = { board, range, unit: UNIT[board], season, since, entries: [] };
  // Temporada fechada: placar vazio é a resposta honesta. Somar "desde sempre"
  // seria responder outra pergunta com a cara desta.
  if (!since) return page;

  const { rows } = await pool.query<Row>(query(board), [since, Math.min(Math.max(limit, 1), 100)]);
  page.entries = rows.map((r, i) => ({
    userId: r.user_id,
    rank: i + 1,
    username: r.username,
    displayName: r.display_name?.trim() || r.username,
    avatar: r.config ?? DEFAULT_AVATAR_DTO,
    value: int(r.value),
    fame: int(r.fame),
    agency: r.agency_name,
  }));
  return page;
}
