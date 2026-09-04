import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';
import { DEFAULT_AVATAR_DTO, type AvatarConfigDTO } from '../auth/identity.ts';

/**
 * Segurança social do jogador (PRD §27, SPECs §39).
 *
 * Duas ferramentas, e elas resolvem problemas diferentes:
 *
 *   **Bloquear** é uma ação PRIVADA e imediata. Ninguém revisa, ninguém é
 *   avisado, e o efeito é só entre as duas contas: some da lista de amigos,
 *   nenhum convite passa, nenhum endereço sai. É a única defesa que não depende
 *   de alguém estar de plantão.
 *
 *   **Denunciar** é uma ação PÚBLICA e assíncrona: vira uma linha na fila de
 *   moderação para um humano ler. Não faz nada com a conta denunciada — e é
 *   importante que não faça, senão denunciar vira uma arma.
 *
 * O painel de quem lê a fila não é assunto deste arquivo (é `/admin/*`,
 * SPECs §51). O que existe aqui é a ponta do jogador.
 */

export type ModerationErrorCode = 'SELF_TARGET' | 'USER_NOT_FOUND' | 'INVALID_REPORT';

export class ModerationError extends Error {
  readonly code: ModerationErrorCode;
  readonly httpStatus: number;

  constructor(code: ModerationErrorCode, message: string, httpStatus = 400) {
    super(message);
    this.name = 'ModerationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Há bloqueio em QUALQUER direção entre os dois?
 *
 * A pergunta é simétrica de propósito, embora o bloqueio não seja: quem
 * bloqueou não quer contato, e quem foi bloqueado não pode forçá-lo. Um pedido
 * de amizade que só olhasse um lado deixaria o bloqueado continuar batendo na
 * porta.
 */
export async function blockedBetween(a: string, b: string): Promise<boolean> {
  if (a === b || !UUID.test(a) || !UUID.test(b)) return false;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM user_blocks
      WHERE (user_id = $1 AND blocked_id = $2)
         OR (user_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [a, b],
  );
  return (rowCount ?? 0) > 0;
}

/** Só o que EU bloqueei. É o que a tela de bloqueados mostra. */
export async function hasBlocked(meId: string, otherId: string): Promise<boolean> {
  if (!UUID.test(otherId)) return false;
  const { rowCount } = await pool.query(
    'SELECT 1 FROM user_blocks WHERE user_id = $1 AND blocked_id = $2',
    [meId, otherId],
  );
  return (rowCount ?? 0) > 0;
}

async function assertTarget(meId: string, targetId: string): Promise<void> {
  if (meId === targetId) {
    throw new ModerationError('SELF_TARGET', 'Não dá para fazer isso com a própria conta.', 400);
  }
  if (!UUID.test(targetId)) {
    throw new ModerationError('USER_NOT_FOUND', 'Esta pessoa não existe.', 404);
  }
  const { rowCount } = await pool.query('SELECT 1 FROM users WHERE id = $1', [targetId]);
  if (!rowCount) {
    // Sem filtro de `status`: denunciar e bloquear quem já foi suspenso continua
    // valendo — a suspensão pode acabar, e a denúncia é justamente sobre o que
    // aconteceu antes.
    throw new ModerationError('USER_NOT_FOUND', 'Esta pessoa não existe.', 404);
  }
}

/**
 * Bloqueia.
 *
 * A amizade CAI junto, na mesma transação. Manter as duas coisas seria manter
 * uma porta aberta — `Homes.canEnter` deixa amigo entrar na casa `friends`, e
 * `locationOfFriend` entrega o shard de quem tem amizade aceita. Um bloqueio que
 * não derruba a amizade não bloqueia nada que importe.
 *
 * O que NÃO cai: os follows. Seguir é assinar conteúdo público, não é contato,
 * e apagar seguidores por bloqueio mexeria em contadores e rankings — outra
 * discussão, com outra tela. O bloqueio já esconde o conteúdo de quem foi
 * bloqueado onde ele aparece para pessoas.
 */
export async function blockUser(meId: string, targetId: string): Promise<{ blocked: boolean }> {
  await assertTarget(meId, targetId);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO user_blocks (user_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [meId, targetId],
    );
    // LEAST/GREATEST reproduz o par ordenado do schema sem precisar ordenar em
    // JavaScript — uuid tem ordem total no Postgres.
    await client.query(
      `DELETE FROM friendships
        WHERE user_a = LEAST($1::uuid, $2::uuid) AND user_b = GREATEST($1::uuid, $2::uuid)`,
      [meId, targetId],
    );
  });

  return { blocked: true };
}

/** Desbloqueia. NÃO restaura a amizade: ela foi apagada, e voltar é pedir de novo. */
export async function unblockUser(meId: string, targetId: string): Promise<{ blocked: boolean }> {
  await pool.query(
    'DELETE FROM user_blocks WHERE user_id = $1 AND blocked_id = $2',
    [meId, targetId],
  );
  return { blocked: false };
}

export interface BlockedUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfigDTO;
  blockedAt: string;
}

export async function listBlocked(meId: string): Promise<BlockedUser[]> {
  const { rows } = await pool.query<{
    blocked_id: string; username: string; display_name: string | null;
    config: AvatarConfigDTO | null; created_at: Date;
  }>(
    `SELECT b.blocked_id, u.username, p.display_name, av.config, b.created_at
       FROM user_blocks b
       JOIN users u ON u.id = b.blocked_id
       LEFT JOIN profiles p ON p.user_id = u.id
       LEFT JOIN avatars av ON av.user_id = u.id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC`,
    [meId],
  );
  return rows.map((r) => ({
    userId: r.blocked_id,
    username: r.username,
    displayName: r.display_name || r.username,
    avatar: r.config ?? DEFAULT_AVATAR_DTO,
    blockedAt: r.created_at.toISOString(),
  }));
}

export type ReportType = 'chat' | 'profile' | 'live' | 'avatar' | 'other';

const REPORT_TYPES: ReadonlySet<string> = new Set<ReportType>(['chat', 'profile', 'live', 'avatar', 'other']);

export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && REPORT_TYPES.has(value);
}

export interface ReportInput {
  reporterId: string;
  targetId: string;
  type: ReportType;
  reason: string;
  /** Qual mensagem, qual live, qual perfil. Texto livre curto; a fila usa para achar. */
  contextId?: string | null;
}

export interface ReportResult {
  reportId: string;
  status: string;
  /** Já havia uma denúncia igual em aberto; esta não criou linha nova. */
  duplicate: boolean;
}

/**
 * Registra a denúncia.
 *
 * Denúncia repetida do mesmo alvo, do mesmo tipo, com uma aberta nas últimas 24
 * horas não vira linha nova: responde a que já existe. Não é economia de
 * espaço — é que a fila é lida por gente, e vinte cópias do mesmo caso empurram
 * para baixo dezenove casos diferentes. O jogador continua vendo "denúncia
 * registrada", que é verdade: ela está lá.
 */
export async function reportUser(input: ReportInput): Promise<ReportResult> {
  await assertTarget(input.reporterId, input.targetId);

  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 1_000) {
    throw new ModerationError('INVALID_REPORT', 'Descreva o que aconteceu (de 3 a 1000 caracteres).', 400);
  }
  if (!isReportType(input.type)) {
    throw new ModerationError('INVALID_REPORT', 'Tipo de denúncia desconhecido.', 400);
  }

  const existing = await pool.query<{ id: string; status: string }>(
    `SELECT id, status FROM moderation_reports
      WHERE reporter_id = $1 AND target_id = $2 AND type = $3
        AND status IN ('open', 'reviewing')
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [input.reporterId, input.targetId, input.type],
  );
  if (existing.rows[0]) {
    return { reportId: existing.rows[0].id, status: existing.rows[0].status, duplicate: true };
  }

  const { rows } = await pool.query<{ id: string; status: string }>(
    `INSERT INTO moderation_reports (reporter_id, target_id, type, reason, context_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, status`,
    [input.reporterId, input.targetId, input.type, reason, input.contextId?.slice(0, 120) || null],
  );
  return { reportId: rows[0].id, status: rows[0].status, duplicate: false };
}
