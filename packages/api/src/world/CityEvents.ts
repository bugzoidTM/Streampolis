import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';
import { grantCredits } from '../economy/EconomyService.ts';
import { EconomyError } from '../economy/errors.ts';
import { isEnabled } from '../platform/FeatureFlags.ts';

/**
 * Eventos da cidade (PRD §22 e §28; SPECs §67, "Social Expansion").
 *
 * O PRD cita eventos sete vezes e nunca lhes deu seção: são fonte de fama
 * (§22), conteúdo que o admin administra (§28), o que a Arena existe para
 * sediar (§6) e o que agências disputam (§19). Um evento aqui é a menor coisa
 * que atende todas essas frases: **uma janela de tempo, uma métrica e um
 * pódio**.
 *
 * ## O placar é uma consulta
 *
 * Nenhum contador sobe quando alguém joga. Cada métrica é um SELECT sobre os
 * fatos que a cidade já registrava — presentes, lives, PKs, bicos, seguidores —
 * recortado pela janela do evento. O porquê está inteiro em
 * `0020_city_events.sql`; o efeito prático é que um evento pode nascer com a
 * janela já correndo e o placar sair certo, e que a API pode cair no meio sem
 * que ninguém perca ponto.
 *
 * ## Quem ganha um empate
 *
 * Quem chegou primeiro àquele número. Cada métrica devolve, além do total, o
 * INSTANTE DO ÚLTIMO ATO que contou (`last_at`), e o desempate é o menor deles.
 * A alternativa fácil — desempatar por id, ou por conta mais antiga — é um
 * sorteio disfarçado de regra, e é o tipo de coisa que ninguém percebe até
 * alguém perder mil Credits para o alfabeto.
 *
 * ## O jogo não decide o pagamento, e a fama não é comprável
 *
 * A apuração paga pelo `EconomyService`, com chave de idempotência
 * `event_<evento>_<pessoa>`: um evento paga uma pessoa uma vez, mesmo que a
 * apuração rode dez vezes. E a fama que um evento gera (ver `Fame.ts`) vem de
 * TER SUBIDO NO PÓDIO, não da pontuação — senão um evento de `gifts_sent`
 * seria uma máquina de converter dinheiro de terceiros em notoriedade, que é
 * exatamente o que o §22 proíbe em negrito.
 */

// ------------------------------------------------------------- métricas ---

export interface MetricDef {
  id: string;
  label: string;
  /** Como a tela conta o que está no placar: "12 entregas", "40 mil Coins". */
  unit: string;
  /** Uma linha sobre o que fazer para pontuar. */
  hint: string;
  /**
   * SQL que devolve `(user_id, score, last_at)` para a janela. `$1` é o começo
   * e `$2` o fim — sempre `>= $1 AND < $2`, meia janela aberta, para que dois
   * eventos encostados não contem o mesmo segundo duas vezes.
   */
  sql: string;
}

/**
 * As seis métricas, e todas apontam para uma tabela que já existia.
 *
 * Não há métrica de "tempo online" nem de "mensagens no chat" de propósito: as
 * duas premiam ficar parado, e uma premia poluir. O §29 (princípios de
 * economia) pede que a renda venha de atividade.
 */
export const EVENT_METRICS: readonly MetricDef[] = [
  {
    id: 'gigs_delivered',
    label: 'Bicos entregues',
    unit: 'entregas',
    hint: 'Aceite bicos no Distrito Sombra e complete a rota antes do prazo.',
    sql: `SELECT user_id, count(*)::bigint AS score, max(ended_at) AS last_at
            FROM gig_runs
           WHERE outcome = 'delivered' AND ended_at >= $1 AND ended_at < $2
           GROUP BY user_id`,
  },
  {
    id: 'lives_hosted',
    label: 'Lives transmitidas',
    unit: 'lives',
    hint: 'Abra sua live. Cada transmissão iniciada dentro da janela conta uma.',
    sql: `SELECT host_id AS user_id, count(*)::bigint AS score, max(started_at) AS last_at
            FROM stream_sessions
           WHERE started_at >= $1 AND started_at < $2
           GROUP BY host_id`,
  },
  {
    id: 'live_viewers',
    label: 'Espectadores reunidos',
    unit: 'espectadores',
    hint: 'Transmita e traga gente: conta o público único das suas lives.',
    sql: `SELECT host_id AS user_id, sum(unique_viewers)::bigint AS score, max(started_at) AS last_at
            FROM stream_sessions
           WHERE started_at >= $1 AND started_at < $2
           GROUP BY host_id`,
  },
  {
    id: 'pk_wins',
    label: 'Vitórias em PK',
    unit: 'vitórias',
    hint: 'Chame alguém ao palco e vença a batalha.',
    sql: `SELECT winner_id AS user_id, count(*)::bigint AS score, max(ended_at) AS last_at
            FROM pk_matches
           WHERE winner_id IS NOT NULL AND ended_at >= $1 AND ended_at < $2
           GROUP BY winner_id`,
  },
  {
    id: 'followers_gained',
    label: 'Novos seguidores',
    unit: 'seguidores',
    hint: 'Apareça: conta quem passou a seguir você durante o evento.',
    sql: `SELECT followed_id AS user_id, count(*)::bigint AS score, max(created_at) AS last_at
            FROM follows
           WHERE created_at >= $1 AND created_at < $2
           GROUP BY followed_id`,
  },
  {
    id: 'gifts_received',
    /**
     * Recebidos, medidos em Creator Points — o rastro do presente na mão de
     * quem recebeu. Não existe métrica de presentes DADOS: ela premiaria quem
     * gastou mais dinheiro real, e o pódio da cidade viraria o extrato de quem
     * tem o cartão maior. O prestígio de quem presenteia já tem lugar
     * próprio no §17.
     */
    label: 'Presentes recebidos',
    unit: 'Creator Points',
    hint: 'Transmita e emocione: conta os Creator Points dos presentes que você recebeu.',
    sql: `SELECT receiver_id AS user_id, sum(creator_points)::bigint AS score, max(created_at) AS last_at
            FROM gift_events
           WHERE created_at >= $1 AND created_at < $2
           GROUP BY receiver_id`,
  },
] as const;

const METRIC_BY_ID = new Map(EVENT_METRICS.map((m) => [m.id, m]));

export function isEventMetric(value: string): boolean {
  return METRIC_BY_ID.has(value);
}

// ---------------------------------------------------------------- leitura ---

export interface EventRow {
  id: string;
  slug: string;
  title: string;
  flavor: string;
  metric: string;
  scene: string | null;
  starts_at: Date;
  ends_at: Date;
  podium: number[];
  min_score: string | number;
  status: string;
  settled_at: Date | null;
}

/**
 * Como um nome vira o nome que a tela mostra.
 *
 * A mesma expressão do §23: o apelido do perfil quando existe e não é só
 * espaço, o `username` quando não. Escrita uma vez e interpolada nas três
 * consultas porque duas versões dela é como o placar do evento e o placar da
 * temporada acabariam chamando a mesma pessoa por nomes diferentes.
 */
const NOME = `coalesce(nullif(btrim(pr.display_name), ''), u.username)`;

export interface StandingEntry {
  rank: number;
  userId: string;
  displayName: string;
  score: number;
  /** Quanto esta colocação paga se o evento fechar assim. */
  credits: number;
  /** Já premiado de fato (evento apurado), e não uma projeção. */
  awarded: boolean;
}

export type EventPhase = 'upcoming' | 'running' | 'settled' | 'cancelled';

export interface EventView {
  id: string;
  slug: string;
  title: string;
  flavor: string;
  metric: string;
  metricLabel: string;
  unit: string;
  hint: string;
  scene: string | null;
  startsAt: string;
  endsAt: string;
  podium: number[];
  minScore: number;
  phase: EventPhase;
  /** Quanto falta para começar ou acabar, em ms. Negativo nunca. */
  msLeft: number;
  standings: StandingEntry[];
  /** Onde QUEM PERGUNTOU está — mesmo fora do top. `null` para anônimo. */
  you: StandingEntry | null;
  /** Quantas pessoas pontuaram acima do mínimo. */
  participants: number;
}

function phaseOf(row: EventRow, agora: number): EventPhase {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'settled') return 'settled';
  if (agora < row.starts_at.getTime()) return 'upcoming';
  if (agora >= row.ends_at.getTime()) return 'settled';
  return 'running';
}

/** Quanto a colocação `rank` (1-based) paga neste pódio. */
export function prizeAt(podium: readonly number[], rank: number): number {
  return rank >= 1 && rank <= podium.length ? podium[rank - 1] ?? 0 : 0;
}

/**
 * O placar ao vivo, do banco.
 *
 * `status = 'active'` filtra banido e apagado: um evento não coroa quem a
 * moderação acabou de tirar do ar, e o §27 seria letra morta se o banido
 * continuasse no letreiro da praça.
 */
async function standingsOf(
  row: EventRow, limite: number,
): Promise<{ list: StandingEntry[]; total: number }> {
  const metric = METRIC_BY_ID.get(row.metric);
  if (!metric) return { list: [], total: 0 };

  const { rows } = await pool.query<{
    user_id: string; display_name: string; score: string; posicao: string; total: string;
  }>(
    `WITH bruto AS (${metric.sql}),
     valido AS (
       SELECT b.user_id, b.score, b.last_at, ${NOME} AS display_name
         FROM bruto b
         JOIN users u ON u.id = b.user_id
         LEFT JOIN profiles pr ON pr.user_id = b.user_id
        WHERE b.score >= $3 AND u.status = 'active'
     )
     SELECT user_id, display_name, score,
            row_number() OVER (ORDER BY score DESC, last_at ASC) AS posicao,
            count(*) OVER () AS total
       FROM valido
      ORDER BY posicao
      LIMIT $4`,
    [row.starts_at, row.ends_at, Number(row.min_score), limite],
  );

  const total = rows[0] ? Number(rows[0].total) : 0;
  return {
    list: rows.map((r) => ({
      rank: Number(r.posicao),
      userId: r.user_id,
      displayName: r.display_name,
      score: Number(r.score),
      credits: prizeAt(row.podium, Number(r.posicao)),
      awarded: false,
    })),
    total,
  };
}

/** O pódio congelado de um evento já apurado. Vem de `event_awards`. */
async function awardsOf(row: EventRow): Promise<{ list: StandingEntry[]; total: number }> {
  const { rows } = await pool.query<{
    user_id: string; display_name: string; rank: number; score: string; credits: number;
  }>(
    `SELECT a.user_id, a.rank, a.score, a.credits,
            coalesce(${NOME}, 'Jogador') AS display_name
       FROM event_awards a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN profiles pr ON pr.user_id = a.user_id
      WHERE a.event_id = $1 ORDER BY a.rank`,
    [row.id],
  );
  return {
    list: rows.map((r) => ({
      rank: r.rank,
      userId: r.user_id,
      displayName: r.display_name,
      score: Number(r.score),
      credits: r.credits,
      awarded: true,
    })),
    total: rows.length,
  };
}

/**
 * A posição de UMA pessoa, mesmo fora do top.
 *
 * Vale uma consulta extra: sem ela, quem está em 41º abre a tela e não se vê em
 * lugar nenhum — o evento vira uma lista de outras pessoas. Aqui a mesma janela
 * do placar é recalculada e a linha da pessoa é pescada pelo id.
 */
async function youIn(row: EventRow, userId: string): Promise<StandingEntry | null> {
  const metric = METRIC_BY_ID.get(row.metric);
  if (!metric) return null;
  const { rows } = await pool.query<{
    display_name: string; score: string; posicao: string;
  }>(
    `WITH bruto AS (${metric.sql}),
     valido AS (
       SELECT b.user_id, b.score, b.last_at, ${NOME} AS display_name
         FROM bruto b
         JOIN users u ON u.id = b.user_id
         LEFT JOIN profiles pr ON pr.user_id = b.user_id
        WHERE b.score >= $3 AND u.status = 'active'
     ),
     posto AS (
       SELECT user_id, display_name, score,
              row_number() OVER (ORDER BY score DESC, last_at ASC) AS posicao
         FROM valido
     )
     SELECT display_name, score, posicao FROM posto WHERE user_id = $4`,
    [row.starts_at, row.ends_at, Number(row.min_score), userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    rank: Number(r.posicao),
    userId,
    displayName: r.display_name,
    score: Number(r.score),
    credits: prizeAt(row.podium, Number(r.posicao)),
    awarded: false,
  };
}

async function viewOf(row: EventRow, userId: string | null, limite: number): Promise<EventView> {
  const agora = Date.now();
  const phase = phaseOf(row, agora);
  const metric = METRIC_BY_ID.get(row.metric);

  // Evento apurado mostra o pódio que FOI pago; o resto mostra o placar vivo.
  // Um evento fechado que recalculasse o placar poderia contradizer o próprio
  // pagamento no dia em que um presente fosse estornado.
  const { list, total } = row.status === 'settled'
    ? await awardsOf(row)
    : row.status === 'cancelled'
      ? { list: [], total: 0 }
      : await standingsOf(row, limite);

  const you = userId
    ? (row.status === 'settled'
      ? list.find((e) => e.userId === userId) ?? null
      : row.status === 'cancelled' ? null : await youIn(row, userId))
    : null;

  const alvo = phase === 'upcoming' ? row.starts_at.getTime() : row.ends_at.getTime();

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    flavor: row.flavor,
    metric: row.metric,
    metricLabel: metric?.label ?? row.metric,
    unit: metric?.unit ?? 'pontos',
    hint: metric?.hint ?? '',
    scene: row.scene,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    podium: row.podium,
    minScore: Number(row.min_score),
    phase,
    msLeft: Math.max(0, alvo - agora),
    standings: list,
    you,
    participants: total,
  };
}

const CAMPOS = `id, slug, title, flavor, metric, scene, starts_at, ends_at,
                podium, min_score, status, settled_at`;

export interface EventsBoard {
  running: EventView[];
  upcoming: EventView[];
  recent: EventView[];
  /** Quanto o jogador tem para receber assim que os eventos vivos fecharem. */
  pendingCredits: number;
}

/**
 * O quadro de eventos.
 *
 * Antes de ler, APURA o que venceu — ver `settleDue`. É de propósito que a
 * apuração pegue carona na leitura: a API não tem agendador (a fama usa o mesmo
 * truque), e quem abre a tela é exatamente quem se importa com o resultado.
 */
export async function eventsBoard(userId: string | null): Promise<EventsBoard> {
  await settleDue().catch(() => undefined);

  const { rows } = await pool.query<EventRow>(
    `SELECT ${CAMPOS} FROM city_events
      WHERE status <> 'cancelled'
        AND ends_at > now() - INTERVAL '14 days'
      ORDER BY starts_at`,
  );

  const vistas = await Promise.all(rows.map((r) => viewOf(r, userId, 10)));
  const running = vistas.filter((v) => v.phase === 'running');
  return {
    running,
    upcoming: vistas.filter((v) => v.phase === 'upcoming'),
    recent: vistas.filter((v) => v.phase === 'settled')
      .sort((a, b) => b.endsAt.localeCompare(a.endsAt)).slice(0, 5),
    pendingCredits: running.reduce((soma, v) => soma + (v.you?.credits ?? 0), 0),
  };
}

/** Um evento pelo slug, com o placar mais fundo (para a tela dedicada). */
export async function eventBySlug(slug: string, userId: string | null): Promise<EventView> {
  await settleDue().catch(() => undefined);
  const { rows } = await pool.query<EventRow>(
    `SELECT ${CAMPOS} FROM city_events WHERE slug = $1`, [slug],
  );
  if (!rows[0]) throw new EconomyError('ITEM_UNKNOWN', 'Evento desconhecido.', 404);
  return viewOf(rows[0], userId, 50);
}

// -------------------------------------------------------------- apuração ---

export interface SettleResult {
  eventId: string;
  slug: string;
  awarded: number;
  credits: number;
}

/**
 * Apura e paga UM evento. Reentrante do começo ao fim.
 *
 * Três travas, e cada uma cobre a falha da anterior:
 *
 *  1. `pg_try_advisory_xact_lock` — duas requisições simultâneas não apuram o
 *     mesmo evento. A segunda desiste em silêncio, porque não há nada de errado
 *     acontecendo: alguém já está fazendo.
 *  2. `ON CONFLICT DO NOTHING` no pódio — se o processo morreu depois de gravar
 *     as colocações, a rodada seguinte não grava um segundo primeiro lugar.
 *  3. a chave de idempotência do pagamento — se morreu DEPOIS de gravar e ANTES
 *     de pagar, a rodada seguinte paga; se morreu depois de pagar, a rodada
 *     seguinte não paga de novo.
 *
 * O `status` só vira `settled` no fim, e é isso que faz uma queda no meio ser
 * recuperável: enquanto ele for `scheduled`, a próxima leitura tenta de novo.
 */
export async function settleEvent(eventId: string): Promise<SettleResult | null> {
  const pendentes = await withTransaction(async (client) => {
    const { rows: trava } = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`city_event_${eventId}`],
    );
    if (!trava[0]?.ok) return null;

    const { rows } = await client.query<EventRow>(
      `SELECT ${CAMPOS} FROM city_events
        WHERE id = $1 AND status = 'scheduled' AND ends_at <= now() FOR UPDATE`,
      [eventId],
    );
    const evento = rows[0];
    if (!evento) return null;

    const metric = METRIC_BY_ID.get(evento.metric);
    // Métrica que sumiu do código (renomeada, removida) não pode virar um
    // pódio arbitrário. O evento fecha sem prêmio e o motivo fica no banco.
    if (!metric) {
      await client.query(
        `UPDATE city_events SET status = 'settled', settled_at = now() WHERE id = $1`, [eventId],
      );
      return null;
    }

    const { rows: colocados } = await client.query<{ user_id: string; score: string; posicao: string }>(
      `WITH bruto AS (${metric.sql}),
       valido AS (
         SELECT b.user_id, b.score, b.last_at
           FROM bruto b JOIN users u ON u.id = b.user_id
          WHERE b.score >= $3 AND u.status = 'active'
       )
       SELECT user_id, score,
              row_number() OVER (ORDER BY score DESC, last_at ASC) AS posicao
         FROM valido ORDER BY posicao LIMIT $4`,
      [evento.starts_at, evento.ends_at, Number(evento.min_score), evento.podium.length],
    );

    for (const c of colocados) {
      const rank = Number(c.posicao);
      const credits = prizeAt(evento.podium, rank);
      if (credits <= 0) continue;
      await client.query(
        `INSERT INTO event_awards (event_id, user_id, rank, score, credits)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id, user_id) DO NOTHING`,
        [eventId, c.user_id, rank, Number(c.score), credits],
      );
    }
    return evento;
  });

  if (!pendentes) return null;

  // O pagamento roda FORA da transação de cima: `grantCredits` abre a sua, e
  // aninhar carteira dentro de outra transação é o caminho conhecido para
  // segurar uma linha de carteira por tempo demais (SPECs §25).
  const { rows: aPagar } = await pool.query<{ user_id: string; credits: number }>(
    'SELECT user_id, credits FROM event_awards WHERE event_id = $1 AND tx_id IS NULL', [pendentes.id],
  );
  let pagos = 0;
  let total = 0;
  for (const a of aPagar) {
    try {
      const saldo = await grantCredits({
        userId: a.user_id,
        amount: a.credits,
        referenceType: 'city_event',
        referenceId: pendentes.slug,
        idempotencyKey: `event_${pendentes.id}_${a.user_id}`,
      });
      await pool.query(
        'UPDATE event_awards SET tx_id = $3 WHERE event_id = $1 AND user_id = $2',
        [pendentes.id, a.user_id, saldo.transaction.id],
      );
      pagos += 1;
      total += a.credits;
    } catch {
      // Uma carteira bloqueada (§28) não pode travar o pódio inteiro. A linha
      // fica sem `tx_id` e a próxima rodada tenta de novo — é para isso que o
      // campo é anulável.
    }
  }

  await pool.query(
    `UPDATE city_events SET status = 'settled', settled_at = now()
      WHERE id = $1 AND status = 'scheduled'`,
    [pendentes.id],
  );

  return { eventId: pendentes.id, slug: pendentes.slug, awarded: pagos, credits: total };
}

/**
 * Apura tudo o que venceu. Chamada por quem abre o quadro; nunca lança.
 *
 * A flag `events_enabled` (§64) para o PAGAMENTO, não a leitura: numa
 * emergência de economia o operador precisa fechar a torneira sem apagar da
 * tela a disputa de quem está no meio dela. Os eventos ficam `scheduled` e
 * vencidos até a flag voltar, e aí são apurados com o placar da janela certa —
 * é a vantagem de o placar ser consulta e não contador.
 */
export async function settleDue(): Promise<SettleResult[]> {
  if (!await isEnabled('events_enabled', true)) return [];
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM city_events WHERE status = 'scheduled' AND ends_at <= now()
      ORDER BY ends_at LIMIT 8`,
  );
  const feitos: SettleResult[] = [];
  for (const r of rows) {
    const feito = await settleEvent(r.id).catch(() => null);
    if (feito) feitos.push(feito);
  }
  return feitos;
}

// ------------------------------------------------------------------ admin ---

export interface CreateEventInput {
  slug: string;
  title: string;
  flavor?: string;
  metric: string;
  scene?: string | null;
  startsAt: Date;
  endsAt: Date;
  podium: number[];
  minScore?: number;
}

/** Teto de prêmio por evento. O §29 pede que a emissão de Credits seja contida. */
export const TETO_DE_PREMIO = 50_000;

export async function createEvent(input: CreateEventInput, createdBy: string): Promise<EventView> {
  if (!await isEnabled('events_enabled', true)) {
    throw new EconomyError('FEATURE_DISABLED', 'Eventos estão desligados no momento.', 503);
  }
  if (!METRIC_BY_ID.has(input.metric)) {
    throw new EconomyError('ITEM_UNKNOWN', 'Métrica de evento desconhecida.', 400);
  }
  if (input.endsAt <= input.startsAt) {
    throw new EconomyError('INVALID_AMOUNT', 'O evento precisa terminar depois de começar.', 400);
  }
  const soma = input.podium.reduce((a, b) => a + b, 0);
  if (soma > TETO_DE_PREMIO) {
    throw new EconomyError('INVALID_AMOUNT', `O pódio inteiro não pode passar de ${TETO_DE_PREMIO} Credits.`, 400);
  }

  // A recusa de sobreposição que o banco não sabe expressar sem `btree_gist`
  // (ver a migration). Dois eventos da mesma métrica ao mesmo tempo fariam o
  // mesmo ato pontuar duas vezes — não é vazamento de economia, é conteúdo
  // errado, e o lugar de barrar conteúdo errado é na criação.
  const { rows: choque } = await pool.query<{ slug: string }>(
    `SELECT slug FROM city_events
      WHERE metric = $1 AND status <> 'cancelled'
        AND starts_at < $3 AND ends_at > $2 LIMIT 1`,
    [input.metric, input.startsAt, input.endsAt],
  );
  if (choque[0]) {
    throw new EconomyError(
      'IDEMPOTENCY_CONFLICT',
      `A janela colide com o evento "${choque[0].slug}", que mede a mesma coisa.`, 409,
    );
  }

  try {
    const { rows } = await pool.query<EventRow>(
      `INSERT INTO city_events
         (slug, title, flavor, metric, scene, starts_at, ends_at, podium, min_score, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${CAMPOS}`,
      [input.slug, input.title, input.flavor ?? '', input.metric, input.scene ?? null,
        input.startsAt, input.endsAt, input.podium, input.minScore ?? 1, createdBy],
    );
    return viewOf(rows[0], null, 10);
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      throw new EconomyError('IDEMPOTENCY_CONFLICT', 'Já existe um evento com esse slug.', 409);
    }
    throw err;
  }
}

/**
 * Desmarcar.
 *
 * Só antes de apurar. Um evento já pago não desaparece — os Credits saíram, e
 * apagar a linha faria o ledger apontar para um evento que "nunca existiu". O
 * §28 dá ao admin o poder de editar conteúdo, não o de reescrever história.
 */
export async function cancelEvent(eventId: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE city_events SET status = 'cancelled'
      WHERE id = $1 AND status = 'scheduled'`, [eventId],
  );
  if (rowCount === 0) {
    throw new EconomyError('ITEM_UNKNOWN', 'Evento não existe ou já foi apurado.', 409);
  }
}

/** A lista do painel: tudo, inclusive cancelado, sem placar (é caro e inútil ali). */
export async function listEventsForAdmin(): Promise<Array<EventView & { createdAt: string }>> {
  const { rows } = await pool.query<EventRow & { created_at: Date }>(
    `SELECT ${CAMPOS}, created_at FROM city_events ORDER BY starts_at DESC LIMIT 100`,
  );
  const agora = Date.now();
  return rows.map((r) => {
    const metric = METRIC_BY_ID.get(r.metric);
    const phase = phaseOf(r, agora);
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      flavor: r.flavor,
      metric: r.metric,
      metricLabel: metric?.label ?? r.metric,
      unit: metric?.unit ?? 'pontos',
      hint: metric?.hint ?? '',
      scene: r.scene,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      podium: r.podium,
      minScore: Number(r.min_score),
      phase,
      msLeft: Math.max(0, (phase === 'upcoming' ? r.starts_at : r.ends_at).getTime() - agora),
      standings: [],
      you: null,
      participants: 0,
      createdAt: r.created_at.toISOString(),
    };
  });
}
