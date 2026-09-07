import { pool } from '../db/pool.ts';

/**
 * Fama (PRD §22).
 *
 * "Fame representa notoriedade dentro de Streampolis. Pode ser conquistada por:
 * espectadores; novos seguidores; lives; PKs; eventos; missões; Creator Points.
 * **O algoritmo não deverá ser diretamente proporcional ao dinheiro gasto por
 * terceiros.** Engajamento e consistência também deverão influenciar."
 *
 * Essa frase em negrito é a única regra dura do parágrafo, e ela decide o
 * desenho inteiro. Creator Points são o rastro do dinheiro que OUTRA pessoa
 * gastou presenteando; somá-los direto faria a fama ser um extrato bancário com
 * outro nome — e o ranking de notoriedade viraria o ranking de quem tem o
 * presenteador mais rico.
 *
 * ## Como o dinheiro entra sem mandar
 *
 * Pela RAIZ QUADRADA. Cem vezes mais Creator Points valem dez vezes mais fama,
 * não cem. Na prática: quem recebeu um presente enorme sobe, e continua abaixo
 * de quem transmitiu trinta vezes para plateias de verdade. Foi por isso que o
 * peso da consistência (dias em que a pessoa apareceu) é o maior da lista —
 * é a única parcela que ninguém compra.
 *
 * ## Derivada, não incrementada
 *
 * Antes desta mudança, `fame` era um contador que só a vitória de PK
 * incrementava. Contador tem o defeito de sempre poder sair do lugar (um evento
 * perdido some para sempre) e de não saber recuar quando o mundo muda — um
 * seguidor que deixa de seguir devolveria fama que ninguém tira.
 *
 * Aqui a fama é o resultado de uma conta sobre fatos, gravado em
 * `player_stats.fame` só porque o ranking precisa ordenar por ela. Quem lê um
 * perfil com a fama velha paga o recálculo daquela pessoa — e de mais ninguém.
 * É o que dá um recálculo contínuo sem agendador.
 */

export interface FameParts {
  /** Espectadores únicos somados das lives da pessoa. */
  viewers: number;
  followers: number;
  lives: number;
  pkWins: number;
  pkMatches: number;
  missions: number;
  /** Pódios em eventos da cidade (§22). Colocações, não pontuação. */
  eventPodiums: number;
  creatorPoints: number;
  /** Dias distintos com interação social — a parcela que não se compra. */
  activeDays: number;
}

/**
 * Os pesos. Todos por unidade, menos `creatorPoints`, que é por RAIZ.
 *
 * A escala foi escolhida para que a primeira sessão de alguém rende algo
 * visível (uma live com dez espectadores e duas missões passa de 100) sem que
 * um único presente caro mude o ranking sozinho.
 */
export const FAME_WEIGHTS = {
  viewer: 5,
  follower: 3,
  live: 10,
  pkWin: 25,
  pkMatch: 10,
  mission: 15,
  /**
   * Por PÓDIO em evento, não por ponto marcado nele.
   *
   * A diferença é a regra em negrito do §22 aplicada a uma feature nova. Um
   * evento de "presentes recebidos" mede, no fundo, dinheiro que outra pessoa
   * gastou; se a fama viesse da pontuação, bastaria um presenteador rico numa
   * semana para comprar um lugar no ranking de notoriedade. Vindo da
   * COLOCAÇÃO, o teto de um evento é um pódio — e um pódio vale menos do que
   * um dia de presença.
   */
  eventPodium: 20,
  /**
   * Por √(Creator Points): 10 mil pontos → 100 → 800 de fama.
   *
   * O peso saiu de 15 para 8 por causa de um teste, e o teste estava certo: com
   * 15, quarenta mil Creator Points (uns R$ 4.000 em presentes) davam 3.000 de
   * fama e passavam na frente de um mês inteiro de transmissão consistente
   * (2.085). Isso é literalmente o que o §22 proíbe. O número aqui não é
   * estético — é onde a regra do PRD vira aritmética.
   */
  creatorPointRoot: 8,
  /** O maior peso da lista, e de propósito: aparecer todo dia é o que ninguém
   *  compra de outra pessoa. */
  activeDay: 30,
} as const;

/**
 * A conta, pura. Fica separada do banco porque é a única parte com uma REGRA
 * de produto dentro — e regra de produto merece teste sem Postgres por perto.
 */
export function fameFrom(parts: FameParts): number {
  const w = FAME_WEIGHTS;
  const total =
    w.viewer * Math.max(0, parts.viewers)
    + w.follower * Math.max(0, parts.followers)
    + w.live * Math.max(0, parts.lives)
    + w.pkWin * Math.max(0, parts.pkWins)
    + w.pkMatch * Math.max(0, parts.pkMatches)
    + w.mission * Math.max(0, parts.missions)
    + w.eventPodium * Math.max(0, parts.eventPodiums)
    + w.creatorPointRoot * Math.sqrt(Math.max(0, parts.creatorPoints))
    + w.activeDay * Math.max(0, parts.activeDays);
  return Math.round(total);
}

/** De onde vem cada parcela. Uma consulta só — são oito tabelas. */
async function partsOf(userId: string): Promise<FameParts> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT coalesce(sum(unique_viewers), 0) FROM stream_sessions WHERE host_id = $1) AS viewers,
       (SELECT count(*) FROM follows WHERE followed_id = $1) AS followers,
       (SELECT count(*) FROM stream_sessions WHERE host_id = $1) AS lives,
       (SELECT count(*) FROM pk_matches WHERE winner_id = $1) AS pk_wins,
       (SELECT count(*) FROM pk_matches WHERE host_a = $1 OR host_b = $1) AS pk_matches,
       (SELECT count(*) FROM mission_claims WHERE user_id = $1) AS missions,
       (SELECT count(*) FROM event_awards WHERE user_id = $1) AS event_podiums,
       (SELECT coalesce(creator_points, 0) FROM player_stats WHERE user_id = $1) AS creator_points,
       (SELECT count(DISTINCT day) FROM social_activity WHERE user_id = $1) AS active_days`,
    [userId],
  );
  const r = rows[0] ?? {};
  return {
    viewers: Number(r.viewers ?? 0),
    followers: Number(r.followers ?? 0),
    lives: Number(r.lives ?? 0),
    pkWins: Number(r.pk_wins ?? 0),
    pkMatches: Number(r.pk_matches ?? 0),
    missions: Number(r.missions ?? 0),
    eventPodiums: Number(r.event_podiums ?? 0),
    creatorPoints: Number(r.creator_points ?? 0),
    activeDays: Number(r.active_days ?? 0),
  };
}

export interface FameView {
  fame: number;
  parts: FameParts;
  /** Quanto cada fonte contribuiu — a fama deixa de ser um número misterioso. */
  breakdown: Record<string, number>;
}

export async function fameOf(userId: string): Promise<FameView> {
  const parts = await partsOf(userId);
  const w = FAME_WEIGHTS;
  return {
    fame: fameFrom(parts),
    parts,
    breakdown: {
      espectadores: w.viewer * parts.viewers,
      seguidores: w.follower * parts.followers,
      lives: w.live * parts.lives,
      pk: w.pkWin * parts.pkWins + w.pkMatch * parts.pkMatches,
      missoes: w.mission * parts.missions,
      eventos: w.eventPodium * parts.eventPodiums,
      creatorPoints: Math.round(w.creatorPointRoot * Math.sqrt(parts.creatorPoints)),
      consistencia: w.activeDay * parts.activeDays,
    },
  };
}

/** Quanto tempo uma fama gravada continua valendo sem recálculo. */
const VALIDADE_MS = 10 * 60 * 1000;

/**
 * Recalcula se estiver velha. **Nunca lança**: fama é enfeite de perfil, e um
 * perfil que não abre porque a fama falhou seria uma troca terrível.
 *
 * Devolve o valor em uso (recalculado ou o que já estava lá).
 */
export async function refreshFame(userId: string, maxAgeMs = VALIDADE_MS): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ fame: string; fame_updated_at: Date | null }>(
      'SELECT fame, fame_updated_at FROM player_stats WHERE user_id = $1', [userId],
    );
    if (!rows[0]) return null;
    const idade = rows[0].fame_updated_at
      ? Date.now() - rows[0].fame_updated_at.getTime()
      : Number.POSITIVE_INFINITY;
    if (idade < maxAgeMs) return Number(rows[0].fame);

    const { fame } = await fameOf(userId);
    await pool.query(
      'UPDATE player_stats SET fame = $2, fame_updated_at = now() WHERE user_id = $1',
      [userId, fame],
    );
    return fame;
  } catch {
    return null;
  }
}
