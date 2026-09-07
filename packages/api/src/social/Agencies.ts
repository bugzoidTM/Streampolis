import { pool } from '../db/pool.ts';
import { withTransaction, isUniqueViolation } from '../db/tx.ts';
import { markSocial } from './SocialActivity.ts';

/**
 * Agências (PRD §19).
 *
 * "Organizações dentro do universo", com dono, gerentes e membros. O PRD
 * autoriza começar simples ("o MVP poderá começar com estrutura simplificada"),
 * e o simples aqui é o que faz uma agência EXISTIR socialmente: alguém funda,
 * convida, a pessoa aceita, e o nome da agência passa a andar junto do avatar
 * pela cidade.
 *
 * ## O nome já viajava assinado
 *
 * `loadIdentity` sempre pôs `agency` no token, e a `PlayerState` sempre teve o
 * campo: a cidade estava pronta para mostrar agência desde antes de existir uma
 * forma de entrar em alguma. Esta é a peça que faltava no meio, e é por isso que
 * nada no game server muda.
 *
 * ## Entrar é ato de duas vontades
 *
 * A agência convida; a pessoa aceita. Não existe "adicionar membro" — arrastar
 * gente para dentro faz de agência uma lista de nomes, e a métrica que o §32
 * chama de principal conta INTERAÇÃO, não cadastro.
 *
 * ## Fama é somada na hora, não guardada
 *
 * `agencies.fame` existe na 0003 e continua zerada de propósito: fama de agência
 * é a soma dos Creator Points de quem está nela AGORA, e um contador guardado
 * sairia do lugar toda vez que alguém entrasse, saísse ou recebesse um presente.
 * Somar na leitura custa um JOIN e nunca mente.
 */

export type AgencyRole = 'owner' | 'manager' | 'member';

export type AgencyErrorCode =
  | 'NAME_TAKEN' | 'NAME_INVALID' | 'ALREADY_IN_AGENCY' | 'NOT_IN_AGENCY'
  | 'NOT_FOUND' | 'FORBIDDEN' | 'NO_INVITE' | 'OWNER_LAST' | 'SELF_TARGET';

export class AgencyError extends Error {
  readonly code: AgencyErrorCode;
  readonly httpStatus: number;

  constructor(code: AgencyErrorCode, message: string, httpStatus = 409) {
    super(message);
    this.name = 'AgencyError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Mesma forma do username: nome de agência aparece no mundo, ao lado do nome
 *  da pessoa, e precisa caber e ser lido. */
const NAME_SHAPE = /^[\p{L}\p{N} .'_-]{3,24}$/u;

export interface AgencyMember {
  userId: string;
  username: string;
  displayName: string;
  role: AgencyRole;
  creatorPoints: number;
  joinedAt: string;
}

export interface AgencyView {
  agencyId: string;
  name: string;
  level: number;
  /** Soma dos Creator Points dos membros atuais — ver o cabeçalho. */
  fame: number;
  ownerId: string;
  memberCount: number;
  createdAt: string;
  members?: AgencyMember[];
}

const AGENCY_SELECT = `
  SELECT a.id, a.name, a.level, a.owner_id, a.created_at,
         count(m.user_id)::int AS members,
         coalesce(sum(s.creator_points), 0)::bigint AS fame
    FROM agencies a
    LEFT JOIN agency_members m ON m.agency_id = a.id
    LEFT JOIN player_stats s ON s.user_id = m.user_id`;

/* eslint-disable @typescript-eslint/no-explicit-any */
const toAgency = (r: any): AgencyView => ({
  agencyId: r.id,
  name: r.name,
  level: r.level,
  fame: Number(r.fame),
  ownerId: r.owner_id,
  memberCount: r.members,
  createdAt: r.created_at.toISOString(),
});

/** O ranking de agências do §19, por fama. */
export async function listAgencies(limit = 50): Promise<AgencyView[]> {
  const { rows } = await pool.query(
    `${AGENCY_SELECT} GROUP BY a.id ORDER BY fame DESC, a.created_at LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map(toAgency);
}

export async function getAgency(agencyId: string): Promise<AgencyView | null> {
  const { rows } = await pool.query(`${AGENCY_SELECT} WHERE a.id = $1 GROUP BY a.id`, [agencyId]);
  if (!rows[0]) return null;
  const agencia = toAgency(rows[0]);
  const membros = await pool.query(
    `SELECT m.user_id, m.role, m.joined_at, u.username, p.display_name,
            coalesce(s.creator_points, 0)::bigint AS creator_points
       FROM agency_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN profiles p ON p.user_id = m.user_id
       LEFT JOIN player_stats s ON s.user_id = m.user_id
      WHERE m.agency_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
               creator_points DESC`,
    [agencyId],
  );
  agencia.members = membros.rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name || r.username,
    role: r.role as AgencyRole,
    creatorPoints: Number(r.creator_points),
    joinedAt: r.joined_at.toISOString(),
  }));
  return agencia;
}

export async function agencyOf(userId: string): Promise<{ agency: AgencyView; role: AgencyRole } | null> {
  const { rows } = await pool.query<{ agency_id: string; role: AgencyRole }>(
    'SELECT agency_id, role FROM agency_members WHERE user_id = $1', [userId],
  );
  if (!rows[0]) return null;
  const agency = await getAgency(rows[0].agency_id);
  return agency ? { agency, role: rows[0].role } : null;
}

export async function createAgency(ownerId: string, name: string): Promise<AgencyView> {
  const nome = (name ?? '').trim();
  if (!NAME_SHAPE.test(nome)) {
    throw new AgencyError('NAME_INVALID', 'Use de 3 a 24 letras, números, espaço, ponto, hífen ou _.', 400);
  }
  const jaTem = await pool.query('SELECT 1 FROM agency_members WHERE user_id = $1', [ownerId]);
  if (jaTem.rowCount) {
    throw new AgencyError('ALREADY_IN_AGENCY', 'Você já pertence a uma agência.', 409);
  }

  try {
    const id = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        'INSERT INTO agencies (owner_id, name) VALUES ($1, $2) RETURNING id', [ownerId, nome],
      );
      await client.query(
        `INSERT INTO agency_members (agency_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [rows[0].id, ownerId],
      );
      return rows[0].id;
    });
    return (await getAgency(id)) as AgencyView;
  } catch (err) {
    if (isUniqueViolation(err, 'agencies_name_key')) {
      throw new AgencyError('NAME_TAKEN', 'Já existe uma agência com este nome.', 409);
    }
    if (isUniqueViolation(err, 'agency_members_one_agency')) {
      throw new AgencyError('ALREADY_IN_AGENCY', 'Você já pertence a uma agência.', 409);
    }
    throw err;
  }
}

async function roleIn(agencyId: string, userId: string): Promise<AgencyRole | null> {
  const { rows } = await pool.query<{ role: AgencyRole }>(
    'SELECT role FROM agency_members WHERE agency_id = $1 AND user_id = $2', [agencyId, userId],
  );
  return rows[0]?.role ?? null;
}

/** Quem manda: dono e gerente convidam e desligam; só o dono muda funções. */
async function assertCanManage(agencyId: string, actorId: string): Promise<AgencyRole> {
  const papel = await roleIn(agencyId, actorId);
  if (papel !== 'owner' && papel !== 'manager') {
    throw new AgencyError('FORBIDDEN', 'Só quem administra a agência pode fazer isso.', 403);
  }
  return papel;
}

export async function inviteToAgency(input: {
  agencyId: string; actorId: string; targetId: string;
}): Promise<{ invited: boolean }> {
  await assertCanManage(input.agencyId, input.actorId);
  if (input.targetId === input.actorId) {
    throw new AgencyError('SELF_TARGET', 'Você já está na agência.', 400);
  }
  const existe = await pool.query('SELECT 1 FROM users WHERE id = $1 AND status = $2', [input.targetId, 'active']);
  if (!existe.rowCount) throw new AgencyError('NOT_FOUND', 'Jogador não encontrado.', 404);
  const jaTem = await pool.query('SELECT 1 FROM agency_members WHERE user_id = $1', [input.targetId]);
  if (jaTem.rowCount) {
    throw new AgencyError('ALREADY_IN_AGENCY', 'Este jogador já pertence a uma agência.', 409);
  }
  await pool.query(
    `INSERT INTO agency_invites (agency_id, user_id, invited_by) VALUES ($1, $2, $3)
     ON CONFLICT (agency_id, user_id) DO NOTHING`,
    [input.agencyId, input.targetId, input.actorId],
  );
  return { invited: true };
}

export interface InviteView {
  agencyId: string;
  name: string;
  invitedBy: string;
  createdAt: string;
}

export async function listInvites(userId: string): Promise<InviteView[]> {
  const { rows } = await pool.query(
    `SELECT i.agency_id, a.name, u.username AS invited_by, i.created_at
       FROM agency_invites i
       JOIN agencies a ON a.id = i.agency_id
       JOIN users u ON u.id = i.invited_by
      WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 20`,
    [userId],
  );
  return rows.map((r) => ({
    agencyId: r.agency_id, name: r.name,
    invitedBy: r.invited_by, createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Aceitar entra na agência e apaga TODOS os convites da pessoa: uma vez dentro,
 * os outros convites viraram lixo — e um convite antigo pendurado é a origem
 * clássica do "entrei na agência errada sem clicar em nada".
 */
export async function acceptInvite(userId: string, agencyId: string): Promise<AgencyView> {
  const convite = await pool.query(
    'SELECT 1 FROM agency_invites WHERE agency_id = $1 AND user_id = $2', [agencyId, userId],
  );
  if (!convite.rowCount) throw new AgencyError('NO_INVITE', 'Você não tem convite desta agência.', 404);

  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO agency_members (agency_id, user_id, role) VALUES ($1, $2, 'member')`,
        [agencyId, userId],
      );
      await client.query('DELETE FROM agency_invites WHERE user_id = $1', [userId]);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'agency_members_one_agency')) {
      throw new AgencyError('ALREADY_IN_AGENCY', 'Você já pertence a uma agência.', 409);
    }
    throw err;
  }
  // §32: entrar numa agência é uma das oito interações sociais.
  void markSocial(userId, 'agency');
  return (await getAgency(agencyId)) as AgencyView;
}

export async function declineInvite(userId: string, agencyId: string): Promise<{ declined: boolean }> {
  const { rowCount } = await pool.query(
    'DELETE FROM agency_invites WHERE agency_id = $1 AND user_id = $2', [agencyId, userId],
  );
  return { declined: (rowCount ?? 0) > 0 };
}

/**
 * Sair ou ser desligado. O DONO não sai pela porta dos membros: ou passa a
 * agência para alguém (`transferOwnership`), ou a dissolve. Sem essa regra,
 * sobra agência sem dono — e ninguém para convidar, promover ou fechar.
 */
export async function removeMember(input: {
  agencyId: string; actorId: string; targetId: string;
}): Promise<{ removed: boolean }> {
  const papelAlvo = await roleIn(input.agencyId, input.targetId);
  if (!papelAlvo) throw new AgencyError('NOT_IN_AGENCY', 'Esta pessoa não está na agência.', 404);
  if (papelAlvo === 'owner') {
    throw new AgencyError('OWNER_LAST', 'O dono não pode sair: transfira ou dissolva a agência.', 409);
  }
  if (input.actorId !== input.targetId) {
    const papelAtor = await assertCanManage(input.agencyId, input.actorId);
    // Gerente não desliga gerente: só o dono mexe em quem administra.
    if (papelAlvo === 'manager' && papelAtor !== 'owner') {
      throw new AgencyError('FORBIDDEN', 'Só o dono desliga um gerente.', 403);
    }
  }
  const { rowCount } = await pool.query(
    'DELETE FROM agency_members WHERE agency_id = $1 AND user_id = $2',
    [input.agencyId, input.targetId],
  );
  return { removed: (rowCount ?? 0) > 0 };
}

export async function setMemberRole(input: {
  agencyId: string; actorId: string; targetId: string; role: 'manager' | 'member';
}): Promise<AgencyView> {
  const papelAtor = await roleIn(input.agencyId, input.actorId);
  if (papelAtor !== 'owner') {
    throw new AgencyError('FORBIDDEN', 'Só o dono muda funções.', 403);
  }
  if (input.targetId === input.actorId) {
    throw new AgencyError('SELF_TARGET', 'O dono não muda a própria função.', 400);
  }
  const { rowCount } = await pool.query(
    `UPDATE agency_members SET role = $3 WHERE agency_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [input.agencyId, input.targetId, input.role],
  );
  if (!rowCount) throw new AgencyError('NOT_IN_AGENCY', 'Esta pessoa não está na agência.', 404);
  return (await getAgency(input.agencyId)) as AgencyView;
}

export async function transferOwnership(input: {
  agencyId: string; actorId: string; targetId: string;
}): Promise<AgencyView> {
  if ((await roleIn(input.agencyId, input.actorId)) !== 'owner') {
    throw new AgencyError('FORBIDDEN', 'Só o dono transfere a agência.', 403);
  }
  if (!(await roleIn(input.agencyId, input.targetId))) {
    throw new AgencyError('NOT_IN_AGENCY', 'Escolha alguém que já esteja na agência.', 404);
  }
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agency_members SET role = 'owner' WHERE agency_id = $1 AND user_id = $2`,
      [input.agencyId, input.targetId],
    );
    await client.query(
      `UPDATE agency_members SET role = 'manager' WHERE agency_id = $1 AND user_id = $2`,
      [input.agencyId, input.actorId],
    );
    await client.query('UPDATE agencies SET owner_id = $2 WHERE id = $1', [input.agencyId, input.targetId]);
  });
  return (await getAgency(input.agencyId)) as AgencyView;
}

/** Dissolver: só o dono, e some com membros e convites (ON DELETE CASCADE). */
export async function disbandAgency(agencyId: string, actorId: string): Promise<{ disbanded: boolean }> {
  if ((await roleIn(agencyId, actorId)) !== 'owner') {
    throw new AgencyError('FORBIDDEN', 'Só o dono dissolve a agência.', 403);
  }
  const { rowCount } = await pool.query('DELETE FROM agencies WHERE id = $1', [agencyId]);
  return { disbanded: (rowCount ?? 0) > 0 };
}
