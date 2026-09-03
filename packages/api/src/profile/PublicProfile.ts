import { pool } from '../db/pool.ts';
import { DEFAULT_AVATAR_DTO, type AvatarConfigDTO } from '../auth/identity.ts';
import { presenceDirectory } from '../social/PresenceDirectory.ts';

/**
 * Perfil público (PRD §15, §16).
 *
 * O que qualquer jogador pode ver de outro: nome, aparência, fama, seguidores,
 * agência e se a porta do apartamento está aberta. O que NÃO sai daqui:
 * e-mail, saldo, extrato e qualquer coisa que só interesse ao dono da conta —
 * um perfil que devolve a carteira alheia é um vazamento, não uma tela.
 */

export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string;
  bio: string;
  avatar: AvatarConfigDTO;
  fame: number;
  level: number;
  creatorPoints: number;
  gifterXp: number;
  gifterLevel: number;
  followers: number;
  following: number;
  agency: string | null;
  presence: string;
  /** Casa do jogador e se dá para bater na porta agora. */
  apartmentId: string | null;
  apartmentVisibility: 'open' | 'friends' | 'private';
  /** Transmitindo agora; `liveRoomId` é a chave de entrada do espectador. */
  isLive: boolean;
  liveRoomId: string | null;
  liveTitle: string | null;
  isSelf: boolean;
  isFollowing: boolean;
}

interface ProfileRow {
  id: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  presence: string | null;
  config: AvatarConfigDTO | null;
  fame: string | number | null;
  level: number | null;
  creator_points: string | number | null;
  gifter_xp: string | number | null;
  gifter_level: number | null;
  agency_name: string | null;
  apartment_id: string | null;
  apartment_visibility: 'open' | 'friends' | 'private' | null;
  live_room_id: string | null;
  live_title: string | null;
  followers: string | number;
  following: string | number;
  is_following: boolean | null;
}

const int = (v: string | number | null | undefined): number => {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : v;
  return Number.isFinite(n as number) ? (n as number) : 0;
};

export async function getPublicProfile(
  userId: string, viewerId?: string,
): Promise<PublicProfile | null> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;

  const { rows } = await pool.query<ProfileRow>(
    `SELECT u.id, u.username, p.display_name, p.bio, p.presence,
            av.config,
            s.fame, s.level, s.creator_points, s.gifter_xp, s.gifter_level,
            a.name AS agency_name,
            prop.id AS apartment_id, prop.visibility AS apartment_visibility,
            live.room_id AS live_room_id, live.title AS live_title,
            (SELECT count(*) FROM follows f WHERE f.followed_id = u.id) AS followers,
            (SELECT count(*) FROM follows f WHERE f.follower_id = u.id) AS following,
            CASE WHEN $2::uuid IS NULL THEN NULL ELSE EXISTS (
              SELECT 1 FROM follows f WHERE f.follower_id = $2::uuid AND f.followed_id = u.id
            ) END AS is_following
       FROM users u
       LEFT JOIN profiles p       ON p.user_id = u.id
       LEFT JOIN avatars av       ON av.user_id = u.id
       LEFT JOIN player_stats s   ON s.user_id = u.id
       LEFT JOIN agency_members m ON m.user_id = u.id
       LEFT JOIN agencies a       ON a.id = m.agency_id
       LEFT JOIN LATERAL (
         SELECT id, visibility FROM properties
          WHERE owner_id = u.id AND property_type = 'apartment'
          ORDER BY created_at LIMIT 1
       ) prop ON TRUE
       LEFT JOIN LATERAL (
         SELECT room_id, title FROM stream_sessions
          WHERE host_id = u.id AND status = 'live'
          ORDER BY started_at DESC LIMIT 1
       ) live ON TRUE
      WHERE u.id = $1 AND u.status = 'active'`,
    [userId, viewerId ?? null],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    bio: row.bio ?? '',
    avatar: row.config ?? DEFAULT_AVATAR_DTO,
    fame: int(row.fame),
    level: int(row.level) || 1,
    creatorPoints: int(row.creator_points),
    gifterXp: int(row.gifter_xp),
    gifterLevel: int(row.gifter_level),
    followers: int(row.followers),
    following: int(row.following),
    agency: row.agency_name,
    // O "agora" vem do diretório efêmero, não da coluna: `profiles.presence`
    // é o registro grosso do banco e ninguém o escreve a cada porta que se
    // atravessa. Quem tem socket aberto é o game server, e é ele que alimenta
    // o diretório — sem isto a tela de perfil diz "offline" para gente que
    // está parada na praça ao lado.
    //
    // Sai o estado, nunca o shard: em que sala a pessoa está é endereço, e
    // endereço exige amizade (ver PresenceDirectory).
    presence: presenceDirectory.statusOf(row.id) ?? row.presence ?? 'offline',
    apartmentId: row.apartment_id,
    apartmentVisibility: row.apartment_visibility ?? 'private',
    isLive: Boolean(row.live_room_id),
    liveRoomId: row.live_room_id,
    liveTitle: row.live_title,
    isSelf: viewerId === row.id,
    isFollowing: row.is_following === true,
  };
}

export interface FollowResult {
  following: boolean;
  followers: number;
}

/**
 * Seguir é idempotente: clicar duas vezes não cria duas linhas nem infla o
 * contador. O contador em `player_stats` é derivado da tabela `follows`, que é
 * a fonte da verdade — recontar é barato e nunca fica torto.
 */
export async function setFollow(
  followerId: string, followedId: string, following: boolean,
): Promise<FollowResult> {
  if (followerId === followedId) {
    return { following: false, followers: await countFollowers(followedId) };
  }

  if (following) {
    await pool.query(
      `INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [followerId, followedId],
    );
  } else {
    await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2',
      [followerId, followedId],
    );
  }

  const followers = await countFollowers(followedId);
  await pool.query(
    `INSERT INTO player_stats (user_id, followers_count) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET followers_count = $2, updated_at = now()`,
    [followedId, followers],
  );
  return { following, followers };
}

/** Ids que este jogador segue. É o que o feed usa para a aba "Seguindo". */
export async function listFollowing(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ followed_id: string }>(
    'SELECT followed_id FROM follows WHERE follower_id = $1',
    [userId],
  );
  return rows.map((r) => r.followed_id);
}

async function countFollowers(userId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*) FROM follows WHERE followed_id = $1',
    [userId],
  );
  return int(rows[0]?.count ?? 0);
}
