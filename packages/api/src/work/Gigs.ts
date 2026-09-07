import { pool } from '../db/pool.ts';
import { grantCredits } from '../economy/EconomyService.ts';
import { EconomyError } from '../economy/errors.ts';
import {
  GIGS, GIG_BY_ID, HEAT_MAX, HEAT_STEPS, HEAT_WINDOW_HOURS, NOIR,
  heatLevel, heatPayout, heatSeconds,
  type GigDef,
} from '../shared.ts';

/**
 * Bicos de rua (PRD §26): "entregas virtuais" e "pequenos gigs".
 *
 * ## A divisão de autoridade, que é a decisão inteira
 *
 * Um bico é uma rota: paradas na ordem, dentro de um prazo. Isso encosta em
 * duas autoridades que o projeto separa de propósito (ver o quadro "Quem manda
 * em quê"):
 *
 *   * **posição é do Game Server.** Ele tem o socket, integra o movimento e é o
 *     único que sabe onde alguém está. A API não sabe e não deve saber — uma
 *     posição contada pelo navegador é uma entrega teletransportada;
 *   * **dinheiro é da API.** Ela paga na entrega, dentro da transação do
 *     ledger, e o Game Server obedece.
 *
 * Então a conversa é curta e num sentido só: o servidor manda "fulano chegou na
 * parada N do bico X" e esta camada confere TRÊS coisas antes de aceitar — que
 * a corrida existe e é da pessoa, que N é exatamente a parada seguinte, e que o
 * prazo não venceu. Nada disso pode ser conferido do lado de lá: o game server
 * não tem a corrida, tem o corpo.
 *
 * ## O prazo é conferido na leitura, não por rotina
 *
 * Não existe cron apagando corridas vencidas. A corrida expira quando alguém
 * pergunta por ela — na tela, no próximo aceite ou na próxima chegada. Uma
 * rotina que varre o banco de minuto em minuto para mudar uma linha que
 * ninguém está olhando é trabalho constante para um efeito que só importa na
 * hora em que a pergunta é feita.
 *
 * ## O que acontece quando o prazo estoura
 *
 * Nada. Sem multa, sem bloqueio, sem espera. A corrida vira `expired` e a
 * pessoa pode aceitar outra na hora seguinte — inclusive a mesma. É o §9
 * aplicado aqui: "esses sistemas não deverão impedir o jogador de participar do
 * jogo de maneira excessivamente punitiva". O custo de falhar é o tempo que já
 * se gastou, e ele é custo suficiente.
 */

export interface GigStopView {
  id: string;
  hint: string;
  x: number;
  z: number;
  label: string;
  done: boolean;
}

export interface GigRunView {
  runId: string;
  gigId: string;
  title: string;
  heat: number;
  credits: number;
  deadlineAt: string;
  startedAt: string;
  stopsDone: number;
  stops: GigStopView[];
  /** A parada da vez, ou nulo se todas foram cumpridas. */
  next: GigStopView | null;
}

export interface GigOfferView {
  id: string;
  title: string;
  flavor: string;
  stops: number;
  /** Já com o efeito da atenção: é isto que o jogador vai receber. */
  credits: number;
  seconds: number;
}

export interface GigBoardView {
  heat: number;
  heatMax: number;
  /** Corridas entregues na janela — o que sustenta o nível atual. */
  runsInWindow: number;
  /** Quantas faltam para a próxima estrela, ou nulo no topo. */
  toNextLevel: number | null;
  windowHours: number;
  offers: GigOfferView[];
  active: GigRunView | null;
}

function definicao(gigId: string): GigDef {
  const gig = GIG_BY_ID.get(gigId);
  if (!gig) throw new EconomyError('ITEM_UNKNOWN', 'Bico desconhecido.', 404);
  return gig;
}

/** Quantas corridas esta pessoa entregou dentro da janela de atenção. */
async function corridasNaJanela(userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM gig_runs
      WHERE user_id = $1 AND outcome = 'delivered'
        AND ended_at > now() - ($2 || ' hours')::interval`,
    [userId, HEAT_WINDOW_HOURS],
  );
  return Number(rows[0].n);
}

interface RunRow {
  id: string;
  gig_id: string;
  heat: number;
  stops_done: number;
  deadline_at: Date;
  started_at: Date;
  credits: number;
}

/**
 * A corrida em curso, já com o prazo aplicado.
 *
 * Se o prazo venceu, ela é FECHADA aqui e a função devolve nulo — a leitura é
 * o que faz a expiração acontecer. `RETURNING` na mesma instrução, e não um
 * SELECT seguido de UPDATE: duas chamadas simultâneas fechariam a mesma corrida
 * duas vezes, e a segunda acharia que fechou uma corrida que já não existia.
 */
async function corridaAtiva(userId: string): Promise<RunRow | null> {
  const vencida = await pool.query(
    `UPDATE gig_runs SET outcome = 'expired', ended_at = now()
      WHERE user_id = $1 AND outcome = 'running' AND deadline_at <= now()
      RETURNING id`,
    [userId],
  );
  if (vencida.rowCount) return null;

  const { rows } = await pool.query<RunRow>(
    `SELECT id, gig_id, heat, stops_done, deadline_at, started_at, credits
       FROM gig_runs WHERE user_id = $1 AND outcome = 'running'`,
    [userId],
  );
  return rows[0] ?? null;
}

function vista(row: RunRow): GigRunView {
  const gig = definicao(row.gig_id);
  const stops: GigStopView[] = gig.stops.map((s, i) => {
    const ponto = NOIR.stops[s.id] ?? null;
    return {
      id: s.id,
      hint: s.hint,
      // Um bico que aponta para um endereço que sumiu da planta não deve
      // derrubar a tela: ele aponta para a origem, e o gate de bicos reprova.
      x: ponto?.x ?? 0,
      z: ponto?.z ?? 0,
      label: ponto?.label ?? s.id,
      done: i < row.stops_done,
    };
  });
  return {
    runId: row.id,
    gigId: row.gig_id,
    title: gig.title,
    heat: row.heat,
    credits: row.credits,
    deadlineAt: row.deadline_at.toISOString(),
    startedAt: row.started_at.toISOString(),
    stopsDone: row.stops_done,
    stops,
    next: stops[row.stops_done] ?? null,
  };
}

/** O quadro de bicos: o nível de atenção, o que está no ar e a corrida atual. */
export async function gigBoard(userId: string): Promise<GigBoardView> {
  const [naJanela, ativa] = await Promise.all([
    corridasNaJanela(userId),
    corridaAtiva(userId),
  ]);
  const nivel = heatLevel(naJanela);
  const proximoPasso = HEAT_STEPS[nivel];

  return {
    heat: nivel,
    heatMax: HEAT_MAX,
    runsInWindow: naJanela,
    toNextLevel: proximoPasso === undefined ? null : proximoPasso - naJanela,
    windowHours: HEAT_WINDOW_HOURS,
    // As ofertas mostram o valor JÁ corrigido pela atenção. Mostrar o valor
    // base e pagar outro é a forma mais barata de perder a confiança do
    // jogador na economia inteira.
    offers: GIGS.map((g) => ({
      id: g.id,
      title: g.title,
      flavor: g.flavor,
      stops: g.stops.length,
      credits: heatPayout(g.credits, nivel),
      seconds: heatSeconds(g.seconds, nivel),
    })),
    active: ativa ? vista(ativa) : null,
  };
}

/**
 * Aceitar um bico.
 *
 * O prazo e o pagamento são CONGELADOS aqui, com o nível de atenção do momento
 * do aceite. Ler o nível de novo na entrega faria a regra mudar no meio da
 * corrida — inclusive encurtando um prazo que já estava correndo.
 */
export async function acceptGig(userId: string, gigId: string): Promise<GigRunView> {
  const gig = definicao(gigId);
  // Fecha uma corrida vencida antes de tentar abrir a próxima: sem isso o
  // índice de "uma por vez" recusaria o aceite por causa de uma corrida que
  // ninguém pode mais cumprir.
  const emCurso = await corridaAtiva(userId);
  if (emCurso) {
    throw new EconomyError('ITEM_NOT_OWNED', 'Termine ou abandone o bico atual antes de aceitar outro.', 409);
  }

  const nivel = heatLevel(await corridasNaJanela(userId));
  const segundos = heatSeconds(gig.seconds, nivel);
  const credits = heatPayout(gig.credits, nivel);

  try {
    const { rows } = await pool.query<RunRow>(
      `INSERT INTO gig_runs (user_id, gig_id, heat, deadline_at, credits)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5)
       RETURNING id, gig_id, heat, stops_done, deadline_at, started_at, credits`,
      [userId, gig.id, nivel, segundos, credits],
    );
    return vista(rows[0]);
  } catch (err) {
    // O índice parcial é quem garante uma corrida por vez. Dois aceites
    // simultâneos passam os dois pela leitura acima; um deles bate aqui.
    if ((err as { code?: string }).code === '23505') {
      throw new EconomyError('ITEM_NOT_OWNED', 'Você já tem um bico em andamento.', 409);
    }
    throw err;
  }
}

/** Desistir. Sem multa e sem espera — ver a nota sobre o §9 no topo. */
export async function abandonGig(userId: string): Promise<{ abandoned: boolean }> {
  const { rowCount } = await pool.query(
    `UPDATE gig_runs SET outcome = 'abandoned', ended_at = now()
      WHERE user_id = $1 AND outcome = 'running'`,
    [userId],
  );
  return { abandoned: (rowCount ?? 0) > 0 };
}

export interface CheckpointResult {
  /** A corrida depois da chegada, ou nulo se ela terminou nesta parada. */
  run: GigRunView | null;
  /** A chegada foi aceita? Um `false` não é erro: é uma parada fora de ordem. */
  accepted: boolean;
  delivered: boolean;
  credits: number;
  balances?: { coins: number; credits: number };
}

/**
 * "Fulano chegou na parada N."
 *
 * Só o game server chama isto (`/internal/gigs/checkpoint`), porque só ele sabe
 * onde alguém está. O que ele NÃO sabe é se aquela é a parada da vez, se a
 * corrida é daquela pessoa e se o prazo venceu — e é exatamente isso que esta
 * função confere antes de deixar a rota avançar.
 *
 * O índice da parada viaja na chamada e é comparado com `stops_done`. Aceitar
 * "cheguei" sem o índice deixaria uma volta em torno da MESMA parada avançar a
 * rota inteira, que é o atalho que qualquer um encontraria em dois minutos.
 */
export async function reachCheckpoint(
  userId: string, gigId: string, stopIndex: number,
): Promise<CheckpointResult> {
  const ativa = await corridaAtiva(userId);
  if (!ativa || ativa.gig_id !== gigId) return { run: null, accepted: false, delivered: false, credits: 0 };

  const gig = definicao(ativa.gig_id);
  if (stopIndex !== ativa.stops_done) {
    // Fora de ordem. Não é erro do servidor de jogo: ele reporta a proximidade
    // e a ordem é conhecimento daqui. Pisar de novo na parada anterior cai
    // neste caminho e não faz nada, que é o comportamento certo.
    return { run: vista(ativa), accepted: false, delivered: false, credits: 0 };
  }

  const avancado = ativa.stops_done + 1;
  const ultima = avancado >= gig.stops.length;

  if (!ultima) {
    const { rows } = await pool.query<RunRow>(
      `UPDATE gig_runs SET stops_done = $2
        WHERE id = $1 AND outcome = 'running' AND stops_done = $3
        RETURNING id, gig_id, heat, stops_done, deadline_at, started_at, credits`,
      [ativa.id, avancado, ativa.stops_done],
    );
    if (!rows[0]) return { run: vista(ativa), accepted: false, delivered: false, credits: 0 };
    return { run: vista(rows[0]), accepted: true, delivered: false, credits: 0 };
  }

  /**
   * A última parada: fechar e pagar.
   *
   * A ordem importa. Primeiro fecha a corrida com uma condição que só passa uma
   * vez (`outcome = 'running'`) e só então paga; se a marcação não pegar, é
   * porque outra chamada já fechou esta corrida, e pagar de novo seria pagar
   * duas vezes. A chave de idempotência do ledger carrega o id da corrida, que
   * é único, então nem uma repetição de rede paga duas vezes.
   */
  const fechada = await pool.query(
    `UPDATE gig_runs SET stops_done = $2, outcome = 'delivered', ended_at = now()
      WHERE id = $1 AND outcome = 'running' AND stops_done = $3
      RETURNING id`,
    [ativa.id, avancado, ativa.stops_done],
  );
  if (!fechada.rowCount) return { run: null, accepted: false, delivered: false, credits: 0 };

  const pago = await grantCredits({
    userId,
    amount: ativa.credits,
    referenceType: 'gig_run',
    referenceId: ativa.id,
    idempotencyKey: `gig_${ativa.id}`,
  });

  // A transação fica gravada na corrida: sem ela, "entregue e pago" seria
  // palavra nossa; com ela, o extrato do jogador e o bico contam a mesma
  // história.
  await pool.query('UPDATE gig_runs SET tx_id = $2 WHERE id = $1', [ativa.id, pago.transaction.id]);

  return {
    run: null,
    accepted: true,
    delivered: true,
    credits: ativa.credits,
    balances: pago.balances,
  };
}
