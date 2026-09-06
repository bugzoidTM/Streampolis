import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';

/**
 * Painel administrativo — parte de moderação (PRD §27, §28; SPECs §37, §65).
 *
 * O jogo pede denúncia desde o começo e guardava todas numa tabela que ninguém
 * lia. Uma fila sem painel é pior do que parece: ela ensina o jogador que
 * denunciar não faz nada, e essa é uma lição difícil de desensinar.
 *
 * ## O que decide o desenho
 *
 * **Toda ação escreve no `audit_log`, e toda ação exige MOTIVO.** O PRD manda
 * motivo obrigatório para ajuste de saldo (§28); aqui a regra vale para
 * qualquer coisa que atinja uma conta, porque a pergunta que aparece seis meses
 * depois é sempre a mesma — "por que essa pessoa foi banida?" — e a resposta
 * tem de estar escrita por quem baniu, não deduzida do horário.
 *
 * **Quem pune não se pune, e ninguém pune quem está acima.** Moderador não
 * alcança moderador nem admin; é o que impede uma conta de staff comprometida
 * de desmontar a equipe inteira.
 *
 * **Punir derruba a sessão.** Suspender ou banir apaga os refresh tokens: sem
 * isso a pessoa continuaria renovando a sessão por 30 dias. O access token que
 * já está na mão dela vale no máximo 15 minutos — é a janela do §36, e está
 * documentada aqui porque é a única parte da punição que não é imediata.
 */

export type AdminErrorCode =
  | 'NOT_FOUND' | 'FORBIDDEN' | 'REASON_REQUIRED' | 'INVALID_ACTION' | 'SELF_TARGET';

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  readonly httpStatus: number;

  constructor(code: AdminErrorCode, message: string, httpStatus = 400) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export type StaffRole = 'moderator' | 'admin';
export type ReportStatus = 'open' | 'reviewing' | 'resolved' | 'rejected';
export type SanctionAction = 'suspend' | 'ban' | 'mute' | 'unmute' | 'reinstate';

const SANCTIONS: ReadonlySet<string> = new Set<SanctionAction>(
  ['suspend', 'ban', 'mute', 'unmute', 'reinstate'],
);

export function isSanctionAction(value: unknown): value is SanctionAction {
  return typeof value === 'string' && SANCTIONS.has(value);
}

/** Motivo é obrigatório em toda ação de painel. Curto demais não é motivo. */
function assertReason(reason: string): string {
  const limpo = (reason ?? '').trim();
  if (limpo.length < 3) {
    throw new AdminError('REASON_REQUIRED', 'Descreva o motivo desta ação.', 400);
  }
  return limpo.slice(0, 1_000);
}

export interface Actor {
  userId: string;
  role: StaffRole;
  ip?: string;
}

/**
 * A linha do audit log. Fora de transação por padrão porque um registro é
 * melhor que nenhum: se a ação passou e o log falhasse junto, perderíamos as
 * duas coisas. Quando o chamador tem transação, ele passa o client.
 */
export async function audit(input: {
  actor: Actor; action: string; targetType?: string; targetId?: string;
  reason?: string; metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, reason, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.actor.userId, input.actor.role, input.action, input.targetType ?? null,
      input.targetId ?? null, input.reason ?? null, JSON.stringify(input.metadata ?? {}),
      input.actor.ip ?? null],
  );
}

// ------------------------------------------------------------- denúncias ---

export interface ReportView {
  id: string;
  type: string;
  reason: string;
  contextId: string | null;
  status: ReportStatus;
  createdAt: string;
  reporter: { userId: string; username: string };
  target: { userId: string; username: string; status: string; role: string };
  /** Quantas denúncias ABERTAS este alvo acumula. É o número que separa um
   *  desafeto de um problema real, e sem ele a fila é uma lista de anedotas. */
  openAgainstTarget: number;
  resolution: string | null;
  resolvedBy: string | null;
}

const REPORT_SELECT = `
  SELECT r.id, r.type, r.reason, r.context_id, r.status, r.created_at,
         r.resolution, r.resolved_by,
         rep.id AS reporter_id, rep.username AS reporter_username,
         tgt.id AS target_id, tgt.username AS target_username,
         tgt.status AS target_status, tgt.role AS target_role,
         (SELECT count(*) FROM moderation_reports o
           WHERE o.target_id = r.target_id AND o.status IN ('open','reviewing')) AS open_against
    FROM moderation_reports r
    JOIN users rep ON rep.id = r.reporter_id
    JOIN users tgt ON tgt.id = r.target_id`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toReport = (r: any): ReportView => ({
  id: r.id,
  type: r.type,
  reason: r.reason,
  contextId: r.context_id,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  reporter: { userId: r.reporter_id, username: r.reporter_username },
  target: {
    userId: r.target_id, username: r.target_username,
    status: r.target_status, role: r.target_role,
  },
  openAgainstTarget: Number(r.open_against),
  resolution: r.resolution,
  resolvedBy: r.resolved_by,
});

export async function listReports(
  filtro: { status?: ReportStatus; targetId?: string; limit?: number } = {},
): Promise<ReportView[]> {
  const limite = Math.min(Math.max(filtro.limit ?? 50, 1), 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (filtro.status) { args.push(filtro.status); where.push(`r.status = $${args.length}`); }
  if (filtro.targetId) { args.push(filtro.targetId); where.push(`r.target_id = $${args.length}`); }
  args.push(limite);
  const { rows } = await pool.query(
    `${REPORT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.created_at DESC LIMIT $${args.length}`,
    args,
  );
  return rows.map(toReport);
}

/**
 * "Estou olhando esta." Sem isso, dois moderadores trabalham a mesma denúncia e
 * o segundo descobre isso depois de decidir — e a segunda decisão sobrescreve a
 * primeira sem que ninguém veja.
 */
export async function claimReport(reportId: string, actor: Actor): Promise<ReportView> {
  const { rows } = await pool.query(
    `UPDATE moderation_reports SET status = 'reviewing', resolved_by = $2
      WHERE id = $1 AND status = 'open' RETURNING id`,
    [reportId, actor.userId],
  );
  if (rows.length === 0) {
    const atual = await getReport(reportId);
    if (!atual) throw new AdminError('NOT_FOUND', 'Denúncia não encontrada.', 404);
    throw new AdminError('FORBIDDEN', `Esta denúncia já está em ${atual.status}.`, 409);
  }
  await audit({ actor, action: 'report.claim', targetType: 'report', targetId: reportId });
  return (await getReport(reportId)) as ReportView;
}

export async function getReport(reportId: string): Promise<ReportView | null> {
  const { rows } = await pool.query(`${REPORT_SELECT} WHERE r.id = $1`, [reportId]);
  return rows[0] ? toReport(rows[0]) : null;
}

export async function resolveReport(input: {
  reportId: string; actor: Actor; decision: 'resolved' | 'rejected'; resolution: string;
}): Promise<ReportView> {
  const motivo = assertReason(input.resolution);
  if (input.decision !== 'resolved' && input.decision !== 'rejected') {
    throw new AdminError('INVALID_ACTION', 'Decisão deve ser resolved ou rejected.', 400);
  }
  const { rows } = await pool.query(
    `UPDATE moderation_reports SET status = $2, resolution = $3, resolved_by = $4
      WHERE id = $1 AND status IN ('open','reviewing') RETURNING id`,
    [input.reportId, input.decision, motivo, input.actor.userId],
  );
  if (rows.length === 0) {
    const atual = await getReport(input.reportId);
    if (!atual) throw new AdminError('NOT_FOUND', 'Denúncia não encontrada.', 404);
    throw new AdminError('FORBIDDEN', 'Esta denúncia já foi decidida.', 409);
  }
  await audit({
    actor: input.actor, action: `report.${input.decision}`,
    targetType: 'report', targetId: input.reportId, reason: motivo,
  });
  return (await getReport(input.reportId)) as ReportView;
}

// --------------------------------------------------------------- contas ---

export interface UserRow {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  mutedUntil: string | null;
  economyBlocked: boolean;
  createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const toUser = (r: any): UserRow => ({
  userId: r.id,
  username: r.username,
  displayName: r.display_name || r.username,
  role: r.role,
  status: r.status,
  mutedUntil: r.chat_muted_until ? r.chat_muted_until.toISOString() : null,
  economyBlocked: r.economy_blocked,
  createdAt: r.created_at.toISOString(),
});

const USER_SELECT = `
  SELECT u.id, u.username, u.role, u.status, u.chat_muted_until, u.economy_blocked,
         u.created_at, p.display_name
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id`;

/**
 * Localizar (§28). Aceita id, username ou e-mail — quem chega ao painel chega
 * com o que a denúncia trouxe, e isso muda conforme de onde ela veio.
 *
 * A busca por e-mail é EXATA de propósito: prefixo de e-mail permitiria varrer
 * a base de endereços com um painel de moderação, que é o tipo de vazamento que
 * a própria equipe faz sem perceber.
 */
export async function searchUsers(query: string, limit = 20): Promise<UserRow[]> {
  const q = (query ?? '').trim();
  if (q.length < 2) return [];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
  const { rows } = await pool.query(
    `${USER_SELECT}
      WHERE ($2::boolean AND u.id = $1::uuid)
         OR u.username_lower LIKE lower($3)
         OR u.email_lower = lower($1)
      ORDER BY u.created_at DESC LIMIT $4`,
    [q, uuid, `${q.toLowerCase()}%`, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map(toUser);
}

export interface Dossier {
  user: UserRow;
  wallet: { coins: number; credits: number };
  reportsAgainst: ReportView[];
  reportsFiled: number;
  recentTransactions: Array<{ id: string; currency: string; type: string; amount: number; createdAt: string }>;
  history: AuditEntry[];
}

/** "Analisar histórico" (§28): tudo o que a equipe precisa antes de decidir,
 *  numa chamada só — três telas para julgar uma pessoa levam a julgar sem ler. */
export async function userDossier(userId: string): Promise<Dossier> {
  const { rows } = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [userId]);
  if (!rows[0]) throw new AdminError('NOT_FOUND', 'Conta não encontrada.', 404);

  const [carteira, contraEle, feitas, extrato, historico] = await Promise.all([
    pool.query('SELECT coins_balance, credits_balance FROM wallets WHERE user_id = $1', [userId]),
    listReports({ targetId: userId, limit: 20 }),
    pool.query('SELECT count(*) AS n FROM moderation_reports WHERE reporter_id = $1', [userId]),
    pool.query(
      `SELECT id, currency, type, amount, created_at FROM wallet_transactions
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [userId],
    ),
    listAudit({ targetId: userId, limit: 20 }),
  ]);

  return {
    user: toUser(rows[0]),
    wallet: {
      coins: Number(carteira.rows[0]?.coins_balance ?? 0),
      credits: Number(carteira.rows[0]?.credits_balance ?? 0),
    },
    reportsAgainst: contraEle,
    reportsFiled: Number(feitas.rows[0].n),
    recentTransactions: extrato.rows.map((t) => ({
      id: t.id, currency: t.currency, type: t.type,
      amount: Number(t.amount), createdAt: t.created_at.toISOString(),
    })),
    history: historico,
  };
}

export interface SanctionInput {
  actor: Actor;
  targetId: string;
  action: SanctionAction;
  reason: string;
  /** Só para `mute`: por quantos minutos. */
  minutes?: number;
}

export interface SanctionResult {
  user: UserRow;
  action: SanctionAction;
  /** Sessões derrubadas (refresh tokens apagados). */
  sessionsRevoked: number;
}

const MUTE_MAX_MINUTES = 60 * 24 * 30;

export async function applySanction(input: SanctionInput): Promise<SanctionResult> {
  const motivo = assertReason(input.reason);
  if (!isSanctionAction(input.action)) {
    throw new AdminError('INVALID_ACTION', 'Ação desconhecida.', 400);
  }
  if (input.targetId === input.actor.userId) {
    throw new AdminError('SELF_TARGET', 'Não dá para aplicar isto em você mesmo.', 400);
  }

  const alvo = await pool.query<{ role: StaffRole | 'player' }>(
    'SELECT role FROM users WHERE id = $1', [input.targetId],
  );
  if (!alvo.rows[0]) throw new AdminError('NOT_FOUND', 'Conta não encontrada.', 404);
  // Moderador não alcança staff. Um admin, sim — alguém precisa poder.
  if (alvo.rows[0].role !== 'player' && input.actor.role !== 'admin') {
    throw new AdminError('FORBIDDEN', 'Só um administrador age sobre a equipe.', 403);
  }

  const minutos = input.action === 'mute'
    ? Math.min(Math.max(Math.trunc(input.minutes ?? 60), 1), MUTE_MAX_MINUTES)
    : 0;

  const revogadas = await withTransaction(async (client) => {
    switch (input.action) {
      case 'suspend':
        await client.query(`UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1`, [input.targetId]);
        break;
      case 'ban':
        await client.query(`UPDATE users SET status = 'banned', updated_at = now() WHERE id = $1`, [input.targetId]);
        break;
      case 'reinstate':
        await client.query(
          `UPDATE users SET status = 'active', chat_muted_until = NULL, updated_at = now() WHERE id = $1`,
          [input.targetId],
        );
        break;
      case 'mute':
        await client.query(
          `UPDATE users SET chat_muted_until = now() + make_interval(mins => $2), updated_at = now()
            WHERE id = $1`,
          [input.targetId, minutos],
        );
        break;
      case 'unmute':
        await client.query(
          `UPDATE users SET chat_muted_until = NULL, updated_at = now() WHERE id = $1`, [input.targetId],
        );
        break;
    }
    // Suspensão e banimento derrubam a sessão; silenciar não — a pessoa
    // continua jogando, só não fala, e desconectá-la seria outra punição.
    if (input.action === 'suspend' || input.action === 'ban') {
      const { rowCount } = await client.query(
        'DELETE FROM refresh_tokens WHERE user_id = $1', [input.targetId],
      );
      return rowCount ?? 0;
    }
    return 0;
  });

  await audit({
    actor: input.actor, action: `user.${input.action}`, targetType: 'user',
    targetId: input.targetId, reason: motivo,
    metadata: input.action === 'mute' ? { minutes: minutos } : {},
  });

  const { rows } = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [input.targetId]);
  return { user: toUser(rows[0]), action: input.action, sessionsRevoked: revogadas };
}

// ----------------------------------------------------------------- log ---

export interface AuditEntry {
  id: string;
  action: string;
  actor: { userId: string | null; username: string | null; role: string | null };
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export async function listAudit(
  filtro: { targetId?: string; action?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  const args: unknown[] = [];
  const where: string[] = [];
  if (filtro.targetId) { args.push(filtro.targetId); where.push(`a.target_id = $${args.length}`); }
  if (filtro.action) { args.push(filtro.action); where.push(`a.action = $${args.length}`); }
  args.push(Math.min(Math.max(filtro.limit ?? 50, 1), 200));
  const { rows } = await pool.query(
    `SELECT a.id, a.action, a.actor_id, a.actor_role, a.target_type, a.target_id,
            a.reason, a.metadata, a.created_at, u.username
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.created_at DESC LIMIT $${args.length}`,
    args,
  );
  return rows.map((r) => ({
    id: String(r.id),
    action: r.action,
    actor: { userId: r.actor_id, username: r.username, role: r.actor_role },
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    metadata: r.metadata ?? {},
    createdAt: r.created_at.toISOString(),
  }));
}
