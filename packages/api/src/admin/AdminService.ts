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

// -------------------------------------------------------------- economia ---

/**
 * Economia no painel (PRD §28, §29; SPECs §65).
 *
 * Estas três ações exigem o papel de **administrador**, não o de moderador, e a
 * diferença não é hierarquia por hierarquia: silenciar alguém por uma hora e
 * creditar 10.000 Coins na carteira de alguém têm raios de explosão diferentes.
 * Moderação atende ao que acontece na sala; saldo é dinheiro que já foi pago.
 *
 * O ajuste em si é o `adminAdjustment` da economia, que existe desde o começo e
 * até hoje não tinha porta: ele já escreve no ledger imutável, exige motivo e é
 * idempotente. O que faltava era exatamente isto — a porta, e quem pode abri-la.
 */

export interface WalletAdjustInput {
  actor: Actor;
  targetId: string;
  currency: 'coins' | 'credits';
  /** Assinado: positivo credita, negativo debita. */
  amount: number;
  reason: string;
  /** Sem ela, um duplo-clique no painel credita duas vezes. */
  idempotencyKey: string;
}

export async function assertAdmin(actor: Actor): Promise<void> {
  if (actor.role !== 'admin') {
    throw new AdminError('FORBIDDEN', 'Só um administrador mexe em saldo.', 403);
  }
}

export async function setEconomyBlock(input: {
  actor: Actor; targetId: string; blocked: boolean; reason: string;
}): Promise<UserRow> {
  await assertAdmin(input.actor);
  const motivo = assertReason(input.reason);
  if (input.targetId === input.actor.userId) {
    throw new AdminError('SELF_TARGET', 'Não dá para bloquear a própria carteira.', 400);
  }
  const { rowCount } = await pool.query(
    'UPDATE users SET economy_blocked = $2, updated_at = now() WHERE id = $1',
    [input.targetId, input.blocked],
  );
  if (!rowCount) throw new AdminError('NOT_FOUND', 'Conta não encontrada.', 404);

  await audit({
    actor: input.actor,
    action: input.blocked ? 'economy.block' : 'economy.unblock',
    targetType: 'user', targetId: input.targetId, reason: motivo,
  });
  const { rows } = await pool.query(`${USER_SELECT} WHERE u.id = $1`, [input.targetId]);
  return toUser(rows[0]);
}

export interface AdminCoinPackage {
  id: string; name: string; coins: number; bonusCoins: number;
  priceCents: number; currency: string; sortOrder: number; active: boolean;
}

/** A vitrine pública mostra só o que está ativo; o painel precisa ver tudo. */
export async function listAllCoinPackages(): Promise<AdminCoinPackage[]> {
  const { rows } = await pool.query(
    `SELECT id, name, coins, bonus_coins, price_cents, currency, sort_order, active
       FROM coin_packages ORDER BY sort_order, price_cents`,
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, coins: Number(r.coins), bonusCoins: Number(r.bonus_coins),
    priceCents: r.price_cents, currency: r.currency, sortOrder: r.sort_order, active: r.active,
  }));
}

/**
 * "Configurar pacotes" (§28). Preço e disponibilidade mudam; a QUANTIDADE de
 * Coins não muda por aqui de propósito: alterar quantos Coins um pacote entrega
 * reescreve, na prática, o que quem já comprou pagou. Pacote com outra
 * quantidade é pacote NOVO, e o antigo se desativa.
 */
export async function updateCoinPackage(input: {
  actor: Actor; packageId: string; reason: string;
  active?: boolean; priceCents?: number; sortOrder?: number;
}): Promise<AdminCoinPackage> {
  await assertAdmin(input.actor);
  const motivo = assertReason(input.reason);
  const campos: string[] = [];
  const args: unknown[] = [input.packageId];
  if (input.active !== undefined) { args.push(input.active); campos.push(`active = $${args.length}`); }
  if (input.priceCents !== undefined) {
    if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) {
      throw new AdminError('INVALID_ACTION', 'Preço deve ser inteiro positivo em centavos.', 400);
    }
    args.push(input.priceCents); campos.push(`price_cents = $${args.length}`);
  }
  if (input.sortOrder !== undefined) { args.push(input.sortOrder); campos.push(`sort_order = $${args.length}`); }
  if (campos.length === 0) throw new AdminError('INVALID_ACTION', 'Nada a mudar.', 400);

  const { rowCount } = await pool.query(
    `UPDATE coin_packages SET ${campos.join(', ')} WHERE id = $1`, args,
  );
  if (!rowCount) throw new AdminError('NOT_FOUND', 'Pacote não encontrado.', 404);

  await audit({
    actor: input.actor, action: 'economy.package_update', targetType: 'coin_package',
    targetId: input.packageId, reason: motivo,
    metadata: { active: input.active, priceCents: input.priceCents, sortOrder: input.sortOrder },
  });
  const todos = await listAllCoinPackages();
  return todos.find((p) => p.id === input.packageId) as AdminCoinPackage;
}

// ----------------------------------------------------------------- lives ---

export interface LiveView {
  liveId: string;
  roomId: string | null;
  title: string;
  category: string;
  host: { userId: string; username: string; status: string };
  startedAt: string;
  peakViewers: number;
  likes: number;
  coinTotal: number;
  /** Já existe ordem de encerramento esperando para ser entregue? */
  closePending: boolean;
}

/** "Visualizar ativas" (§28). O que está no ar AGORA, com quem é o dono. */
export async function listActiveLives(): Promise<LiveView[]> {
  const { rows } = await pool.query(
    `SELECT s.id, s.room_id, s.title, s.category, s.started_at, s.peak_real_viewers,
            s.likes, s.gift_coin_total, u.id AS host_id, u.username, u.status,
            EXISTS (SELECT 1 FROM moderation_commands c
                     WHERE c.target_id = s.room_id AND c.command = 'close_live'
                       AND c.acked_at IS NULL) AS close_pending
       FROM stream_sessions s JOIN users u ON u.id = s.host_id
      WHERE s.status = 'live' ORDER BY s.started_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    liveId: r.id,
    roomId: r.room_id,
    title: r.title,
    category: r.category,
    host: { userId: r.host_id, username: r.username, status: r.status },
    startedAt: r.started_at.toISOString(),
    peakViewers: r.peak_real_viewers,
    likes: Number(r.likes),
    coinTotal: Number(r.gift_coin_total),
    closePending: r.close_pending,
  }));
}

/**
 * "Finalizar" (§28).
 *
 * A API não fala com a sala: ela enfileira a ordem, e o worker a busca no
 * próprio batimento de presença (ver `0012_moderation_commands.sql`). Duas
 * consequências que valem estar escritas:
 *
 *   1. o encerramento não é instantâneo — leva o tempo do próximo batimento,
 *      alguns segundos. Uma live que precisa sumir AGORA se resolve banindo o
 *      host, que derruba a sessão dele;
 *   2. a ordem é idempotente por sala: mandar duas vezes não empilha duas
 *      ordens, porque a segunda encontraria a primeira ainda pendente.
 */
export async function closeLiveByOrder(input: {
  actor: Actor; roomId: string; reason: string;
}): Promise<{ commandId: string; alreadyPending: boolean }> {
  const motivo = assertReason(input.reason);
  const sala = input.roomId.slice(0, 64);

  const pendente = await pool.query<{ id: string }>(
    `SELECT id FROM moderation_commands
      WHERE target_id = $1 AND command = 'close_live' AND acked_at IS NULL`,
    [sala],
  );
  if (pendente.rows[0]) return { commandId: pendente.rows[0].id, alreadyPending: true };

  const viva = await pool.query(
    `SELECT id FROM stream_sessions WHERE room_id = $1 AND status = 'live'`, [sala],
  );
  if (!viva.rows[0]) throw new AdminError('NOT_FOUND', 'Nenhuma live ativa nesta sala.', 404);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO moderation_commands (command, target_type, target_id, reason, issued_by)
     VALUES ('close_live', 'room', $1, $2, $3) RETURNING id`,
    [sala, motivo, input.actor.userId],
  );
  await audit({
    actor: input.actor, action: 'live.close', targetType: 'room', targetId: sala, reason: motivo,
  });
  return { commandId: rows[0].id, alreadyPending: false };
}

export interface PendingCommand {
  id: string;
  command: 'close_live';
  targetType: 'room';
  targetId: string;
  reason: string;
}

/**
 * O que este worker tem para fazer.
 *
 * Chamado pelo `/internal/presence`: as ordens saem daqui MARCADAS como
 * entregues, para o worker seguinte não pegar a mesma. Se o worker morrer entre
 * receber e executar, a ordem fica pendurada — e é por isso que `acked_at`
 * existe separado de `delivered_at`: dá para ver no banco quais ordens foram
 * entregues e nunca confirmadas.
 */
export async function takeCommandsFor(serverId: string, rooms: string[]): Promise<PendingCommand[]> {
  if (rooms.length === 0) return [];
  const { rows } = await pool.query(
    `UPDATE moderation_commands SET delivered_at = now(), delivered_to = $1
      WHERE id IN (
        SELECT id FROM moderation_commands
         WHERE delivered_at IS NULL AND target_id = ANY($2::text[])
         ORDER BY issued_at LIMIT 20
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, command, target_type, target_id, reason`,
    [serverId.slice(0, 64), rooms.slice(0, 500)],
  );
  return rows.map((r) => ({
    id: r.id, command: r.command, targetType: r.target_type,
    targetId: r.target_id, reason: r.reason,
  }));
}

/** O worker confirmando o que fez com a ordem. */
export async function ackCommand(commandId: string, result: string): Promise<void> {
  await pool.query(
    `UPDATE moderation_commands SET acked_at = now(), ack_result = $2
      WHERE id = $1 AND acked_at IS NULL`,
    [commandId, result.slice(0, 200)],
  );
}

// -------------------------------------------------------------- agências ---

export interface AdminAgencyView {
  agencyId: string; name: string; level: number; memberCount: number;
  owner: { userId: string; username: string }; createdAt: string;
}

/** "Agências: consultar" (§28). */
export async function listAgenciesForAdmin(): Promise<AdminAgencyView[]> {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.level, a.created_at, u.id AS owner_id, u.username,
            count(m.user_id)::int AS members
       FROM agencies a
       JOIN users u ON u.id = a.owner_id
       LEFT JOIN agency_members m ON m.agency_id = a.id
      GROUP BY a.id, u.id ORDER BY members DESC, a.created_at LIMIT 100`,
  );
  return rows.map((r) => ({
    agencyId: r.id, name: r.name, level: r.level, memberCount: r.members,
    owner: { userId: r.owner_id, username: r.username },
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Dissolver pelo painel (§28: "suspender").
 *
 * Sem meio-termo de propósito: uma agência "suspensa" precisaria de um estado
 * novo que nada no jogo lê — nem o token, nem a cidade, nem o ranking —, e um
 * estado que ninguém lê é uma promessa que a interface faz e o mundo não cumpre.
 * O que a moderação precisa hoje é desmanchar o nome que está no avatar de um
 * bando de gente; o dia em que "suspensa" tiver significado, ela nasce com ele.
 */
export async function disbandAgencyByAdmin(input: {
  actor: Actor; agencyId: string; reason: string;
}): Promise<{ disbanded: boolean; members: number }> {
  const motivo = assertReason(input.reason);
  const { rows } = await pool.query<{ name: string; membros: string }>(
    `SELECT a.name, count(m.user_id) AS membros FROM agencies a
       LEFT JOIN agency_members m ON m.agency_id = a.id
      WHERE a.id = $1 GROUP BY a.id`,
    [input.agencyId],
  );
  if (!rows[0]) throw new AdminError('NOT_FOUND', 'Agência não encontrada.', 404);

  await pool.query('DELETE FROM agencies WHERE id = $1', [input.agencyId]);
  await audit({
    actor: input.actor, action: 'agency.disband', targetType: 'agency',
    targetId: input.agencyId, reason: motivo,
    metadata: { name: rows[0].name, members: Number(rows[0].membros) },
  });
  return { disbanded: true, members: Number(rows[0].membros) };
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
