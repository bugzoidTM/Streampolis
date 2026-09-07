import { pool } from '../db/pool.ts';
import { config } from '../config.ts';

/**
 * Necessidades do personagem (PRD §9).
 *
 * Quatro atributos: **Energia** (cai com atividades e lives), **Social**
 * (melhora com interações), **Humor** (influenciado pelas necessidades,
 * atividades e acontecimentos) e **Conforto** (qualidade da casa e dos móveis).
 *
 * E uma frase que manda em tudo: "esses sistemas **não deverão impedir o
 * jogador de participar do jogo de maneira excessivamente punitiva**. Servirão
 * para criar decisões e incentivar variedade."
 *
 * ## O que essa frase proíbe, na prática
 *
 * Um simulador de vida clássico guarda as barras e as faz cair com o relógio.
 * Isso pune exatamente quem esteve fora: a pessoa volta depois de três dias e
 * encontra o personagem no chão, com trabalho a fazer antes de poder jogar. É a
 * definição de punitivo, e é o modelo que este arquivo NÃO usa.
 *
 * Aqui as quatro são **derivadas dos fatos**, como a fama e as missões:
 *
 *   * **Energia** cai com o que a pessoa FEZ (live, PK) e volta com o tempo. Não
 *     ficar jogando é descanso, não castigo — quem some por três dias volta com
 *     100;
 *   * **Social** olha os últimos sete dias de interação. Quem parou de conversar
 *     vê o número baixar devagar, e a dica diz o que fazer. Não trava nada;
 *   * **Conforto** é a casa: quantos móveis, e de que qualidade. Não decai — um
 *     sofá não some porque você viajou;
 *   * **Humor** é função das outras três mais os acontecimentos bons recentes
 *     (presente recebido, missão resgatada), que é exatamente o que o §9 diz.
 *
 * ## Elas não dão bônus nem penalidade
 *
 * De propósito, e é a decisão mais fácil de errar aqui. Bônus por humor alto é
 * penalidade por humor baixo com outro nome — e o §9 pede para não punir. Elas
 * servem para o que a frase seguinte diz: **criar decisões**. Cada atributo vem
 * com uma dica do que fazer, e a dica aponta para uma parte diferente do jogo.
 * É o "incentivar variedade" sem nenhuma trava.
 */

export interface NeedFacts {
  /** Lives abertas nas últimas 12 h, da mais recente para a mais velha (em h). */
  recentLiveHours: number[];
  /** PKs nas últimas 12 h, em horas atrás. */
  recentPkHours: number[];
  /** Tipos distintos de interação nos últimos 7 dias (0–8). */
  socialKinds7d: number;
  /** Dias com alguma interação nos últimos 7. */
  activeDays7d: number;
  /** Móveis colocados na própria casa. */
  furniture: number;
  /** Valor somado dos móveis em Credits — qualidade, não só quantidade. */
  furnitureValue: number;
  /** Acontecimentos bons nas últimas 48 h: presentes recebidos e missões pagas. */
  goodEvents48h: number;
}

export interface Needs {
  energia: number;
  social: number;
  humor: number;
  conforto: number;
}

/**
 * O piso da energia. Nunca zero: uma barra no chão é a forma clássica de a
 * simulação virar castigo, e o §9 proíbe isso em uma frase.
 */
const ENERGIA_MINIMA = 25;

/** Quanto uma live custa de energia no momento em que acaba. */
const CUSTO_LIVE = 22;
const CUSTO_PK = 12;
/** Em quantas horas o cansaço de uma atividade se desfaz por completo. */
const HORAS_DE_DESCANSO = 12;

const limita = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(n)));

/**
 * A conta, pura — é aqui que mora a regra do §9, e por isso ela é testável sem
 * banco nenhum.
 */
export function needsFrom(f: NeedFacts): Needs {
  /**
   * Cansaço é o que sobrou das atividades recentes, e ele se desfaz sozinho.
   * Uma live de duas horas atrás pesa menos que a de agora; a de treze horas
   * atrás não pesa nada.
   */
  const peso = (horas: number) => Math.max(0, 1 - horas / HORAS_DE_DESCANSO);
  const cansaco =
    f.recentLiveHours.reduce((s, h) => s + CUSTO_LIVE * peso(h), 0)
    + f.recentPkHours.reduce((s, h) => s + CUSTO_PK * peso(h), 0);
  const energia = limita(100 - cansaco, ENERGIA_MINIMA);

  /**
   * Social premia VARIEDADE de interação, não volume: oito tipos diferentes
   * valem mais que mil mensagens do mesmo tipo. É o "incentivar variedade" do
   * §9 escrito em aritmética.
   */
  const social = limita(f.socialKinds7d * 9 + f.activeDays7d * 4);

  /**
   * Conforto é a casa. Quantidade conta pouco e qualidade conta mais — cinco
   * banquinhos não fazem um lar. Ter um apartamento já vale alguma coisa: o
   * jogador acabou de chegar e mora em algum lugar.
   */
  const conforto = limita(
    20
    + Math.min(30, f.furniture * 6)
    + Math.min(50, f.furnitureValue / 60),
  );

  /**
   * Humor é o que o §9 descreve: função das necessidades ("influenciado por
   * necessidades") mais os acontecimentos ("atividades e acontecimentos"). Peso
   * maior no social porque este é um jogo sobre estar com gente.
   */
  const base = energia * 0.3 + social * 0.4 + conforto * 0.3;
  const humor = limita(base + Math.min(15, f.goodEvents48h * 5));

  return { energia, social, humor, conforto };
}

export interface NeedView {
  id: keyof Needs;
  label: string;
  value: number;
  /** O que fazer a respeito. É para isto que as necessidades existem (§9). */
  hint: string;
}

/**
 * A dica de cada atributo, escolhida pelo VALOR. Cada uma aponta para uma parte
 * diferente do jogo — praça, casa, loja, live —, que é o "incentivar variedade"
 * sem trava nenhuma.
 */
function hintFor(id: keyof Needs, valor: number): string {
  const baixo = valor < 45;
  switch (id) {
    case 'energia':
      return baixo
        ? 'Você transmitiu bastante. Um tempo fora do palco recupera sozinho.'
        : 'De pé para o que vier: dá para abrir uma live agora.';
    case 'social':
      return baixo
        ? 'Faz tempo que você não vê ninguém. Dê uma volta na praça ou visite um amigo.'
        : 'Sua semana está cheia de gente — é disso que a cidade vive.';
    case 'conforto':
      return baixo
        ? 'A casa está vazia. Um móvel novo na loja muda o ambiente.'
        : 'Sua casa está do jeito que você gosta.';
    case 'humor':
      return baixo
        ? 'Um pouco para baixo. Costuma passar com companhia e uma casa melhor.'
        : 'No melhor astral.';
  }
}

const LABELS: Record<keyof Needs, string> = {
  energia: 'Energia', social: 'Social', humor: 'Humor', conforto: 'Conforto',
};

export interface NeedsView {
  needs: Needs;
  views: NeedView[];
  facts: NeedFacts;
}

async function factsOf(userId: string): Promise<NeedFacts> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT coalesce(array_agg(extract(epoch FROM now() - started_at) / 3600), '{}')
          FROM stream_sessions
         WHERE host_id = $1 AND started_at > now() - interval '12 hours') AS lives,
       (SELECT coalesce(array_agg(extract(epoch FROM now() - created_at) / 3600), '{}')
          FROM pk_matches
         WHERE (host_a = $1 OR host_b = $1) AND created_at > now() - interval '12 hours') AS pks,
       (SELECT count(DISTINCT kind) FROM social_activity
         WHERE user_id = $1 AND day > (now() AT TIME ZONE $2)::date - 7) AS kinds,
       (SELECT count(DISTINCT day) FROM social_activity
         WHERE user_id = $1 AND day > (now() AT TIME ZONE $2)::date - 7) AS dias,
       (SELECT count(*) FROM property_items pi JOIN properties p ON p.id = pi.property_id
         WHERE p.owner_id = $1) AS moveis,
       (SELECT coalesce(sum(i.credits_price), 0)
          FROM property_items pi
          JOIN properties p ON p.id = pi.property_id
          JOIN inventory inv ON inv.id = pi.item_instance_id
          JOIN items i ON i.id = inv.item_id
         WHERE p.owner_id = $1) AS valor,
       (SELECT count(*) FROM gift_events
         WHERE receiver_id = $1 AND created_at > now() - interval '48 hours')
       + (SELECT count(*) FROM mission_claims
           WHERE user_id = $1 AND claimed_at > now() - interval '48 hours') AS bons`,
    [userId, config.rankingsTimezone],
  );
  const r = rows[0] ?? {};
  return {
    recentLiveHours: (r.lives ?? []).map(Number),
    recentPkHours: (r.pks ?? []).map(Number),
    socialKinds7d: Number(r.kinds ?? 0),
    activeDays7d: Number(r.dias ?? 0),
    furniture: Number(r.moveis ?? 0),
    furnitureValue: Number(r.valor ?? 0),
    goodEvents48h: Number(r.bons ?? 0),
  };
}

export async function needsOf(userId: string): Promise<NeedsView> {
  const facts = await factsOf(userId);
  const needs = needsFrom(facts);
  const views = (Object.keys(LABELS) as Array<keyof Needs>).map((id) => ({
    id, label: LABELS[id], value: needs[id], hint: hintFor(id, needs[id]),
  }));
  return { needs, views, facts };
}
