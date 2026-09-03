import jwt from 'jsonwebtoken';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from '../db/pool.ts';
import { config } from '../config.ts';

/**
 * Identidade de sessão e o token que a carrega (SPECs §36).
 *
 * O token é um SNAPSHOT ASSINADO: além de dizer quem é o usuário, ele carrega o
 * que o game server precisaria perguntar ao banco a cada join — nome, nível de
 * gifter, agência e a APARÊNCIA.
 *
 * A aparência estar aqui é uma decisão de segurança, não de performance. Até
 * agora o navegador informava o próprio avatar ao entrar numa sala, o que
 * significa que qualquer um poderia vestir a roupa de 5.000 Coins pelo console.
 * O que a API assina foi validado contra o inventário; o game server só confere
 * a assinatura e nunca aceita aparência vinda do cliente.
 */

export interface AvatarConfigDTO {
  bodyPreset: number;
  skinTone: number;
  facePreset: number;
  hair: string;
  hairColor: number;
  top: string;
  bottom: string;
  shoes: string;
  accessory: string;
  height: number;
  /**
   * Corpo que desenha o avatar. `'v2'` está reservado e só é aceito de quem
   * POSSUI o item correspondente — a mesma regra de qualquer peça, escrita
   * antes de existir o item, para o dia da venda ser um dia de catálogo.
   */
  body: 'v1' | 'v2';
}

export interface SessionIdentity {
  userId: string;
  displayName: string;
  permissions: string[];
  gifterLevel: number;
  agency: string;
  avatar: AvatarConfigDTO;
}

interface IdentityRow {
  id: string;
  username: string;
  display_name: string | null;
  role: 'player' | 'moderator' | 'admin';
  status: string;
  gifter_level: number | null;
  agency_name: string | null;
  config: AvatarConfigDTO | null;
}

const PERMISSIONS_BY_ROLE: Record<string, string[]> = {
  player: ['play'],
  moderator: ['play', 'moderate'],
  admin: ['play', 'moderate', 'admin'],
};

export async function loadIdentity(userId: string): Promise<SessionIdentity | null> {
  const { rows } = await pool.query<IdentityRow>(
    `SELECT u.id, u.username, p.display_name, u.role, u.status,
            s.gifter_level, a.name AS agency_name, av.config
       FROM users u
       LEFT JOIN profiles p      ON p.user_id = u.id
       LEFT JOIN player_stats s  ON s.user_id = u.id
       LEFT JOIN avatars av      ON av.user_id = u.id
       LEFT JOIN agency_members m ON m.user_id = u.id
       LEFT JOIN agencies a       ON a.id = m.agency_id
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  // Banido ou suspenso não recebe token: barrar no login é mais barato e mais
  // seguro do que barrar em cada sala depois.
  if (row.status !== 'active') return null;

  return {
    userId: row.id,
    displayName: row.display_name || row.username,
    permissions: PERMISSIONS_BY_ROLE[row.role] ?? ['play'],
    gifterLevel: row.gifter_level ?? 0,
    agency: row.agency_name ?? '',
    avatar: row.config ?? DEFAULT_AVATAR_DTO,
  };
}

export const DEFAULT_AVATAR_DTO: AvatarConfigDTO = {
  bodyPreset: 0,
  skinTone: 3,
  facePreset: 0,
  hair: 'm_casual_character_head',
  hairColor: 1,
  top: 'm_casual_character_top',
  bottom: 'm_casual_character_bottom',
  shoes: 'm_casual_character_shoes',
  accessory: '',
  height: 1.0,
  body: 'v1',
};

export interface SessionToken {
  token: string;
  expiresIn: number;
  sessionId: string;
}

/**
 * Assina o token de sessão. HS256 com o mesmo segredo que o game server
 * verifica — ele nunca lê a tabela de usuários, só confere a assinatura.
 */
export function signSessionToken(identity: SessionIdentity): SessionToken {
  const sessionId = randomUUID();
  const ttl = config.jwt.accessTtlSeconds;
  const token = jwt.sign(
    {
      name: identity.displayName,
      perms: identity.permissions,
      gifterLevel: identity.gifterLevel,
      agency: identity.agency,
      avatar: identity.avatar,
      sid: sessionId,
    },
    config.jwt.secret,
    {
      algorithm: 'HS256',
      subject: identity.userId,
      issuer: config.jwt.issuer,
      expiresIn: ttl,
    },
  );
  return { token, expiresIn: ttl, sessionId };
}

// ------------------------------------------------------------- refresh ---

/**
 * O par de tokens de uma sessão.
 *
 * O access token é curto de propósito (§36) e não dá para revogar: quem o tem,
 * entra até ele vencer. O refresh é o oposto — vive no banco, só por hash, e
 * some quando a sessão é encerrada. Um sem o outro não é sessão: sozinho, o
 * access de 15 minutos é uma visita que acaba no meio, e foi exatamente isso
 * que a demonstração fazia — o jogador voltava para a praça em "modo offline"
 * quinze minutos depois de entrar, sem nada na tela dizendo por quê.
 */
export interface SessionTokens extends SessionToken {
  refreshToken: string;
  refreshExpiresIn: number;
}

export type RefreshRejection = 'invalid' | 'expired' | 'reused' | 'account';

export class RefreshError extends Error {
  // Campo declarado à mão: a API roda TypeScript direto no Node, em modo
  // strip-only, onde `constructor(public readonly code)` não existe.
  readonly code: RefreshRejection;

  constructor(code: RefreshRejection) {
    super(code);
    this.name = 'RefreshError';
    this.code = code;
  }
}

/** O refresh viaja em claro uma vez; o banco só conhece o sha-256 dele. */
function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Emite o par inicial: uma FAMÍLIA de refresh nasce aqui e só termina em
 * logout, expiração ou reúso. `familyId` é o que permite matar a sessão
 * inteira quando um token roubado é usado depois de já ter sido rotacionado.
 */
export async function issueSessionTokens(
  identity: SessionIdentity, userAgent?: string,
): Promise<SessionTokens> {
  const access = signSessionToken(identity);
  const refresh = await mintRefresh(identity.userId, randomUUID(), userAgent);
  return { ...access, ...refresh };
}

async function mintRefresh(
  userId: string, familyId: string, userAgent?: string, replaces?: string,
): Promise<{ refreshToken: string; refreshExpiresIn: number }> {
  const token = randomBytes(48).toString('base64url');
  const ttl = config.jwt.refreshTtlSeconds;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO streampolis.refresh_tokens
       (user_id, token_hash, family_id, expires_at, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4), $5)
     RETURNING id`,
    [userId, hashRefresh(token), familyId, ttl, userAgent?.slice(0, 200) ?? null],
  );
  if (replaces) {
    await pool.query(
      `UPDATE streampolis.refresh_tokens
          SET revoked_at = now(), replaced_by = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [replaces, rows[0].id],
    );
  }
  return { refreshToken: token, refreshExpiresIn: ttl };
}

/**
 * Rotação: cada refresh vale UMA vez. O antigo é revogado no mesmo instante em
 * que o novo nasce.
 *
 * Se alguém apresentar um refresh JÁ rotacionado, isso não é um engano do
 * cliente — é o sintoma clássico de token copiado. A família inteira cai, e as
 * duas pontas precisam entrar de novo. Preferir "derruba os dois" a "deixa
 * passar o ladrão" é a decisão, e ela é deliberada.
 */
export async function rotateSession(
  refreshToken: string, userAgent?: string,
): Promise<SessionTokens & { identity: SessionIdentity }> {
  const hash = hashRefresh(refreshToken);
  const { rows } = await pool.query<{
    id: string; user_id: string; family_id: string;
    revoked_at: Date | null; expired: boolean;
  }>(
    `SELECT id, user_id, family_id, revoked_at, (expires_at <= now()) AS expired
       FROM streampolis.refresh_tokens
      WHERE token_hash = $1`,
    [hash],
  );
  const row = rows[0];
  if (!row) throw new RefreshError('invalid');

  if (row.revoked_at) {
    await pool.query(
      `UPDATE streampolis.refresh_tokens
          SET revoked_at = now()
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [row.family_id],
    );
    throw new RefreshError('reused');
  }
  if (row.expired) throw new RefreshError('expired');

  // A identidade é relida do banco, nunca copiada do token antigo: quem foi
  // banido, mudou de nome ou trocou de roupa desde o último login precisa
  // sentir isso no token seguinte.
  const identity = await loadIdentity(row.user_id);
  if (!identity) throw new RefreshError('account');

  const access = signSessionToken(identity);
  const refresh = await mintRefresh(row.user_id, row.family_id, userAgent, row.id);
  return { ...access, ...refresh, identity };
}

/** Encerra a sessão: a família inteira do refresh apresentado é revogada. */
export async function revokeSession(refreshToken: string): Promise<void> {
  await pool.query(
    `UPDATE streampolis.refresh_tokens
        SET revoked_at = now()
      WHERE family_id = (
              SELECT family_id FROM streampolis.refresh_tokens WHERE token_hash = $1
            )
        AND revoked_at IS NULL`,
    [hashRefresh(refreshToken)],
  );
}
