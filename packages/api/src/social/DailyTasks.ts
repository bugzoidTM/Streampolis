import { pool } from '../db/pool.ts';
import { config } from '../config.ts';
import { grantCredits } from '../economy/EconomyService.ts';
import { EconomyError } from '../economy/errors.ts';
import type { SocialKind } from './SocialActivity.ts';

/**
 * Tarefas diárias (PRD §26).
 *
 * A frase que importa do §26 é a última: "isso permite que uma pessoa prospere
 * sem obrigatoriamente se tornar streamer". Antes disto, todo caminho para
 * Credits passava por transmitir — a loja tem itens de 300 a 1.900 Credits e um
 * jogador que só quer morar, conversar e visitar gente não tinha como comprar
 * nenhum.
 *
 * ## Por que só "tarefas diárias" dos quatro trabalhos do §26
 *
 * Atendente, entregas virtuais e pequenos gigs pedem mundo que ainda não
 * existe: balcão com NPC, rota de entrega, alguém para contratar. Implementá-los
 * aqui seria inventar produto e chamar de avançar o PRD. Tarefas diárias, não:
 * elas já acontecem — o jogo só não pagava por elas.
 *
 * ## Elas se apoiam no que a métrica já registra
 *
 * `social_activity` guarda uma linha por pessoa, por dia, por tipo de interação
 * (foi feita para a North Star do §32). É exatamente a pergunta que uma tarefa
 * diária faz: "hoje, essa pessoa conversou?". Nenhum evento novo, nenhum
 * contador — a mesma tabela responde às duas coisas.
 *
 * ## Quanto pagam, e por quê
 *
 * As quatro somam 190 Credits por dia. A mediana da loja é 300: cerca de dois
 * dias de vida na cidade compram um item mediano, e onze dias compram o mais
 * caro. É devagar de propósito — o §26 fala em prosperar sem transmitir, não em
 * prosperar sem jogar —, e é rápido o bastante para a primeira semana de alguém
 * ter um objetivo alcançável.
 */

export interface DailyTaskDef {
  id: string;
  title: string;
  hint: string;
  credits: number;
  /** O tipo de interação que prova a tarefa, em `social_activity`. */
  kind: SocialKind;
}

/**
 * Nenhuma delas exige transmitir. É a regra desta lista, e é o motivo dela
 * existir: quem não quer abrir live precisa de um caminho inteiro, não de um
 * caminho com um degrau de streamer no meio.
 *
 * `live` aqui vale para quem ASSISTE também (ver `SocialSignals`): quem passou
 * a tarde vendo a live dos outros trabalhou tanto quanto quem apareceu na praça.
 */
export const DAILY_TASKS: readonly DailyTaskDef[] = [
  {
    id: 'conversa', title: 'Converse com alguém', kind: 'chat', credits: 40,
    hint: 'Uma mensagem no chat da praça, da casa ou de uma live.',
  },
  {
    id: 'visita', title: 'Visite um apartamento', kind: 'visit', credits: 40,
    hint: 'A casa de um amigo — ou a de qualquer um que deixou a porta aberta.',
  },
  {
    id: 'plateia', title: 'Passe por uma live', kind: 'live', credits: 60,
    hint: 'Assistir conta. Transmitir também.',
  },
  {
    id: 'gente_nova', title: 'Aproxime-se de alguém', kind: 'follow', credits: 50,
    hint: 'Seguir um perfil, mandar convite de amizade ou entrar numa agência.',
  },
] as const;

const BY_ID = new Map(DAILY_TASKS.map((t) => [t.id, t]));

/**
 * O que prova cada tarefa. Exportado porque é a REGRA do §26 em forma de dado —
 * "nenhuma delas exige transmitir" só é verificável olhando isto, não a frase
 * escrita no título.
 */
export const ACCEPTED_KINDS: Record<string, SocialKind[]> = {
  conversa: ['chat'],
  visita: ['visit'],
  plateia: ['live'],
  gente_nova: ['follow', 'friendship', 'agency'],
};

export interface DailyTaskView {
  id: string;
  title: string;
  hint: string;
  credits: number;
  done: boolean;
  claimed: boolean;
}

export interface DailyTasksView {
  /** O dia que está valendo, no fuso do jogador. */
  day: string;
  tasks: DailyTaskView[];
  claimable: number;
  /** Quanto ainda dá para ganhar hoje. */
  creditsAvailable: number;
  /** Quando a lista vira (meia-noite no fuso do jogador), em ISO. */
  resetsAt: string;
}

async function hoje(): Promise<string> {
  const { rows } = await pool.query<{ dia: string }>(
    'SELECT (now() AT TIME ZONE $1)::date::text AS dia', [config.rankingsTimezone],
  );
  return rows[0].dia;
}

export async function listDailyTasks(userId: string): Promise<DailyTasksView> {
  const dia = await hoje();

  const [feitas, resgatadas] = await Promise.all([
    pool.query<{ kind: string }>(
      `SELECT kind FROM social_activity
        WHERE user_id = $1 AND day = (now() AT TIME ZONE $2)::date`,
      [userId, config.rankingsTimezone],
    ),
    pool.query<{ task_id: string }>(
      `SELECT task_id FROM daily_task_claims
        WHERE user_id = $1 AND day = (now() AT TIME ZONE $2)::date`,
      [userId, config.rankingsTimezone],
    ),
  ]);
  const tipos = new Set(feitas.rows.map((r) => r.kind));
  const pagas = new Set(resgatadas.rows.map((r) => r.task_id));

  const tasks = DAILY_TASKS.map((t) => {
    const done = (ACCEPTED_KINDS[t.id] ?? [t.kind]).some((k) => tipos.has(k));
    return {
      id: t.id, title: t.title, hint: t.hint, credits: t.credits,
      done, claimed: pagas.has(t.id),
    };
  });

  // A virada é meia-noite do fuso do jogador — o mesmo corte dos rankings e da
  // métrica. Mandar isso pronto evita a tela recalcular fuso por conta própria.
  const { rows: virada } = await pool.query<{ quando: Date }>(
    `SELECT (date_trunc('day', now() AT TIME ZONE $1) + interval '1 day')
              AT TIME ZONE $1 AS quando`,
    [config.rankingsTimezone],
  );

  return {
    day: dia,
    tasks,
    claimable: tasks.filter((t) => t.done && !t.claimed).length,
    creditsAvailable: tasks.filter((t) => !t.claimed).reduce((s, t) => s + t.credits, 0),
    resetsAt: virada[0].quando.toISOString(),
  };
}

export interface DailyClaimResult {
  taskId: string;
  day: string;
  credits: number;
  balances: { coins: number; credits: number };
  replayed: boolean;
}

/**
 * Resgatar a tarefa do dia.
 *
 * A chave de idempotência do ledger inclui o DIA (`daily_<task>_<dia>_<user>`),
 * e é isso que faz a mesma tarefa poder pagar de novo amanhã sem poder pagar
 * duas vezes hoje. Sem o dia na chave, a segunda diária da vida de alguém seria
 * silenciosamente tratada como repetição da primeira.
 */
export async function claimDailyTask(userId: string, taskId: string): Promise<DailyClaimResult> {
  const tarefa = BY_ID.get(taskId);
  if (!tarefa) throw new EconomyError('ITEM_UNKNOWN', 'Tarefa desconhecida.', 404);

  const dia = await hoje();
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM social_activity
        WHERE user_id = $1 AND day = (now() AT TIME ZONE $2)::date AND kind = ANY($3::text[])
     ) AS ok`,
    [userId, config.rankingsTimezone, ACCEPTED_KINDS[tarefa.id] ?? [tarefa.kind]],
  );
  if (!rows[0].ok) {
    throw new EconomyError('ITEM_NOT_OWNED', 'Esta tarefa ainda não foi cumprida hoje.', 409);
  }

  const marca = await pool.query(
    `INSERT INTO daily_task_claims (user_id, day, task_id, credits)
     VALUES ($1, (now() AT TIME ZONE $2)::date, $3, $4)
     ON CONFLICT (user_id, day, task_id) DO NOTHING RETURNING task_id`,
    [userId, config.rankingsTimezone, tarefa.id, tarefa.credits],
  );
  const jaPaga = marca.rowCount === 0;

  const saldo = await grantCredits({
    userId,
    amount: tarefa.credits,
    referenceType: 'daily_task',
    referenceId: tarefa.id,
    idempotencyKey: `daily_${tarefa.id}_${dia}_${userId}`,
  });

  if (!jaPaga) {
    await pool.query(
      `UPDATE daily_task_claims SET tx_id = $4
        WHERE user_id = $1 AND day = (now() AT TIME ZONE $2)::date AND task_id = $3`,
      [userId, config.rankingsTimezone, tarefa.id, saldo.transaction.id],
    );
  }

  return {
    taskId: tarefa.id,
    day: dia,
    credits: tarefa.credits,
    balances: saldo.balances,
    replayed: jaPaga || saldo.replayed,
  };
}
