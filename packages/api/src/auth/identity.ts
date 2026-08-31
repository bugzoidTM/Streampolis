import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
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
  hair: 'hair_bob_01',
  hairColor: 1,
  top: 'top_tee_01',
  bottom: 'bottom_jeans_01',
  shoes: 'shoes_sneaker_01',
  accessory: '',
  height: 1.0,
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
