import { pool } from '../db/pool.ts';
import { DEFAULT_AVATAR_DTO, type AvatarConfigDTO } from '../auth/identity.ts';
import { blockedBetween } from './Moderation.ts';
import { presenceDirectory, type PresenceKind, type PresenceRecord } from './PresenceDirectory.ts';

/**
 * Amizade (PRD §20).
 *
 * Seguir e ser amigo são coisas diferentes e este arquivo não toca na primeira.
 * Seguir é unilateral e público — é assinatura de conteúdo. Amizade é BILATERAL
 * e é ela que abre portas: a casa marcada como `friends` (ver `Homes.canEnter`)
 * e o endereço exato de alguém no mundo (ver `PresenceDirectory`). Por isso ela
 * precisa de aceite, e por isso o convite tem os quatro estados abaixo.
 *
 * ## Uma linha por amizade
 *
 * O schema guarda o par ORDENADO (`user_a < user_b`, garantido por CHECK), o
 * que faz da relação um fato só em vez de duas linhas que podem discordar. O
 * preço é que toda consulta ordena antes de perguntar, e que "quem pediu" tem
 * de ser uma coluna própria (`requested_by`) — sem ela, a linha não sabe de que
 * lado veio o convite e ninguém consegue distinguir "eu pedi" de "me pediram".
 *
 * ## Bloqueio não mora aqui
 *
 * O enum `friendship_status` tem um valor `'blocked'` que este código nunca
 * escreve. Bloqueio é DIRECIONAL — eu posso bloquear alguém que não me bloqueou
 * — e uma linha simétrica não consegue representar isso sem mentir sobre um dos
 * dois lados. A autoridade é `user_blocks` (ver `Moderation.ts`), e bloquear
 * apaga a amizade em vez de convertê-la.
 */

export type FriendshipState = 'none' | 'outgoing' | 'incoming' | 'friends';

export type FriendshipErrorCode =
  | 'SELF_FRIENDSHIP'
  | 'USER_NOT_FOUND'
  | 'BLOCKED'
  | 'NOT_PENDING'
  | 'NOT_FRIENDS';

/** Erro de regra social. Mesma forma do EconomyError: o server.ts mapeia os dois. */
export class FriendshipError extends Error {
  readonly code: FriendshipErrorCode;
  readonly httpStatus: number;

  constructor(code: FriendshipErrorCode, message: string, httpStatus = 409) {
    super(message);
    this.name = 'FriendshipError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface FriendSummary {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfigDTO;
  gifterLevel: number;
  agency: string | null;
  state: FriendshipState;
  /** Quando a amizade (ou o convite) passou ao estado atual. */
  since: string;
  /**
   * O que a pessoa está fazendo AGORA, ou `null` para offline. Estado grosso, do
   * diretório de presença — o endereço (cena e shard) sai por outra porta, e só
   * entre amigos aceitos (`locationOfFriend`).
   */
  presence: PresenceKind | null;
  online: boolean;
}

export interface FriendLists {
  /** Amizades aceitas, os online primeiro: é essa a lista que serve para ir ao encontro. */
  friends: FriendSummary[];
  /** Convites que chegaram e esperam a minha resposta. */
  incoming: FriendSummary[];
  /** Convites que eu mandei e esperam a resposta do outro. */
  outgoing: FriendSummary[];
}

/** O par como o banco o guarda. Uma amizade, uma linha. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

const UUID = /^[0-9a-f-]{36}$/i;

interface FriendRow {
  user_a: string;
  user_b: string;
  status: 'pending' | 'accepted' | 'blocked';
  requested_by: string;
  updated_at: Date;
  other_id: string;
  username: string;
  display_name: string | null;
  config: AvatarConfigDTO | null;
  gifter_level: number | null;
  agency_name: string | null;
}

/**
 * Como ESTE usuário vê a linha. A mesma linha é "eu pedi" para um lado e "me
 * pediram" para o outro — o estado é ponto de vista, não coluna.
 */
export function friendshipStateFrom(
  viewerId: string, row: Pick<FriendRow, 'status' | 'requested_by'>,
): FriendshipState {
  if (row.status === 'accepted') return 'friends';
  if (row.status !== 'pending') return 'none';
  return row.requested_by === viewerId ? 'outgoing' : 'incoming';
}

function toSummary(viewerId: string, row: FriendRow): FriendSummary {
  const record = presenceDirectory.locationOf(row.other_id);
  return {
    userId: row.other_id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatar: row.config ?? DEFAULT_AVATAR_DTO,
    gifterLevel: row.gifter_level ?? 0,
    agency: row.agency_name,
    state: friendshipStateFrom(viewerId, row),
    since: row.updated_at.toISOString(),
    presence: record?.kind ?? null,
    online: record !== null,
  };
}

/**
 * Todas as linhas em que este usuário aparece, com quem é o outro lado.
 *
 * Uma consulta só para as três listas: o painel de amigos mostra as três
 * juntas, e três idas ao banco para desenhar uma tela seria pagar pelo formato
 * da tabela.
 */
async function edgesOf(userId: string): Promise<FriendRow[]> {
  const { rows } = await pool.query<FriendRow>(
    `SELECT f.user_a, f.user_b, f.status, f.requested_by, f.updated_at,
            u.id AS other_id, u.username, p.display_name, av.config,
            s.gifter_level, a.name AS agency_name
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.user_a = $1 THEN f.user_b ELSE f.user_a END
       LEFT JOIN profiles p       ON p.user_id = u.id
       LEFT JOIN avatars av       ON av.user_id = u.id
       LEFT JOIN player_stats s   ON s.user_id = u.id
       LEFT JOIN agency_members m ON m.user_id = u.id
       LEFT JOIN agencies a       ON a.id = m.agency_id
      WHERE (f.user_a = $1 OR f.user_b = $1)
        AND f.status IN ('pending', 'accepted')
        AND u.status = 'active'
        -- Bloqueio esconde a pessoa dos dois lados. Sem isto, bloquear alguém
        -- deixaria o convite dele piscando no seu sino para sempre.
        AND NOT EXISTS (
          SELECT 1 FROM user_blocks b
           WHERE (b.user_id = $1 AND b.blocked_id = u.id)
              OR (b.user_id = u.id AND b.blocked_id = $1)
        )
      ORDER BY f.updated_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * As três listas da tela de amigos.
 *
 * Os aceitos saem com os ONLINE primeiro, e isso é a tela inteira: uma lista de
 * amigos ordenada por data de aceite enterra as três pessoas com quem dá para
 * fazer alguma coisa agora embaixo de trinta que estão dormindo.
 */
export async function listFriends(userId: string): Promise<FriendLists> {
  const rows = await edgesOf(userId);
  const lists: FriendLists = { friends: [], incoming: [], outgoing: [] };

  for (const row of rows) {
    const summary = toSummary(userId, row);
    if (summary.state === 'friends') lists.friends.push(summary);
    else if (summary.state === 'incoming') lists.incoming.push(summary);
    else if (summary.state === 'outgoing') lists.outgoing.push(summary);
  }

  lists.friends.sort((a, b) => Number(b.online) - Number(a.online)
    || a.displayName.localeCompare(b.displayName, 'pt-BR'));
  return lists;
}

/** O estado da amizade entre dois, do ponto de vista do primeiro. */
export async function friendshipStateOf(viewerId: string, otherId: string): Promise<FriendshipState> {
  if (viewerId === otherId || !UUID.test(otherId)) return 'none';
  const [a, b] = orderedPair(viewerId, otherId);
  const { rows } = await pool.query<{ status: 'pending' | 'accepted' | 'blocked'; requested_by: string }>(
    'SELECT status, requested_by FROM friendships WHERE user_a = $1 AND user_b = $2',
    [a, b],
  );
  const row = rows[0];
  return row ? friendshipStateFrom(viewerId, row) : 'none';
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  return (await friendshipStateOf(a, b)) === 'friends';
}

/** Existe, está ativo e não é uma parede. Roda antes de qualquer escrita. */
async function assertReachable(meId: string, otherId: string): Promise<void> {
  if (meId === otherId) {
    throw new FriendshipError('SELF_FRIENDSHIP', 'Não dá para ser amigo de si mesmo.', 400);
  }
  if (!UUID.test(otherId)) {
    throw new FriendshipError('USER_NOT_FOUND', 'Esta pessoa não existe.', 404);
  }
  const { rowCount } = await pool.query(
    `SELECT 1 FROM users WHERE id = $1 AND status = 'active'`,
    [otherId],
  );
  if (!rowCount) {
    throw new FriendshipError('USER_NOT_FOUND', 'Esta pessoa não existe.', 404);
  }
  if (await blockedBetween(meId, otherId)) {
    // Uma mensagem só para os dois sentidos do bloqueio: dizer "esta pessoa te
    // bloqueou" transforma o bloqueio num aviso para quem foi bloqueado.
    throw new FriendshipError('BLOCKED', 'Não é possível interagir com esta pessoa.', 403);
  }
}

export interface FriendshipResult {
  userId: string;
  state: FriendshipState;
}

/**
 * Manda o convite.
 *
 * Três atalhos deliberados, todos idempotentes — o botão da tela pode ser
 * clicado duas vezes e a rede pode reenviar:
 *
 *  - já somos amigos: nada acontece, responde `friends`;
 *  - eu já pedi: nada acontece, responde `outgoing`;
 *  - **ele já tinha me pedido: a amizade é ACEITA.** Dois convites cruzados são
 *    duas pessoas dizendo sim; obrigar uma delas a achar o convite no sino para
 *    confirmar o que ela mesma acabou de pedir seria burocracia.
 */
export async function requestFriendship(meId: string, otherId: string): Promise<FriendshipResult> {
  await assertReachable(meId, otherId);
  const [a, b] = orderedPair(meId, otherId);

  const { rows } = await pool.query<{ status: 'pending' | 'accepted' | 'blocked'; requested_by: string }>(
    `INSERT INTO friendships (user_a, user_b, status, requested_by)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (user_a, user_b) DO UPDATE
        -- O convite do outro lado vira aceite; o resto fica como está. Escrito
        -- como UPDATE condicional, e não como leia-decida-escreva, porque dois
        -- convites cruzados chegando ao mesmo tempo é exatamente o caso em que
        -- a corrida acontece.
        SET status = CASE
              WHEN friendships.status = 'pending' AND friendships.requested_by <> $3
                THEN 'accepted'::streampolis.friendship_status
              ELSE friendships.status
            END,
            updated_at = CASE
              WHEN friendships.status = 'pending' AND friendships.requested_by <> $3
                THEN now() ELSE friendships.updated_at
            END
     RETURNING status, requested_by`,
    [a, b, meId],
  );

  return { userId: otherId, state: friendshipStateFrom(meId, rows[0]) };
}

/**
 * Aceita. Só o CONVIDADO aceita: a cláusula `requested_by <> $3` é o que impede
 * que quem mandou o convite o aceite sozinho e vire amigo de quem nunca
 * respondeu.
 */
export async function acceptFriendship(meId: string, otherId: string): Promise<FriendshipResult> {
  await assertReachable(meId, otherId);
  const [a, b] = orderedPair(meId, otherId);

  const { rowCount } = await pool.query(
    `UPDATE friendships SET status = 'accepted', updated_at = now()
      WHERE user_a = $1 AND user_b = $2 AND status = 'pending' AND requested_by <> $3`,
    [a, b, meId],
  );
  if (!rowCount) {
    // Pode ser que já sejam amigos (aceitar duas vezes é normal com rede ruim);
    // aí não é erro, é a mesma resposta de novo.
    const state = await friendshipStateOf(meId, otherId);
    if (state === 'friends') return { userId: otherId, state };
    throw new FriendshipError('NOT_PENDING', 'Não há convite desta pessoa para aceitar.', 404);
  }
  return { userId: otherId, state: 'friends' };
}

/**
 * Recusa. Apaga a linha em vez de guardar um "recusado": o convite recusado não
 * é fato que alguém precise consultar depois, e mantê-lo impediria a pessoa de
 * pedir de novo mais tarde — que é o comportamento certo, não uma punição
 * permanente. Quem quer nunca mais ser incomodado bloqueia.
 */
export async function declineFriendship(meId: string, otherId: string): Promise<FriendshipResult> {
  const [a, b] = orderedPair(meId, otherId);
  // Sem `assertReachable`: recusar e remover têm de funcionar mesmo com a conta
  // do outro suspensa ou já bloqueada. Fechar uma porta nunca depende de a
  // outra ponta estar em bom estado.
  await pool.query(
    `DELETE FROM friendships
      WHERE user_a = $1 AND user_b = $2 AND status = 'pending' AND requested_by <> $3`,
    [a, b, meId],
  );
  return { userId: otherId, state: await friendshipStateOf(meId, otherId) };
}

/** Desfaz a amizade (ou cancela o convite que EU mandei). Sempre 200. */
export async function removeFriendship(meId: string, otherId: string): Promise<FriendshipResult> {
  const [a, b] = orderedPair(meId, otherId);
  await pool.query(
    'DELETE FROM friendships WHERE user_a = $1 AND user_b = $2',
    [a, b],
  );
  return { userId: otherId, state: 'none' };
}

export interface FriendLocation {
  userId: string;
  sceneId: string;
  /** O shard. É com ele que se entra na MESMA sala, e não numa cópia dela. */
  roomId: string;
  kind: PresenceKind;
  since: number;
}

/**
 * Onde o amigo está — cena E shard (SPECs §17).
 *
 * Esta é a informação que o `PresenceDirectory` guarda separada do status
 * público justamente para não sair sem permissão: com o `roomId` na mão se
 * chega até a pessoa. O portão é amizade ACEITA, conferida a cada chamada e não
 * herdada de uma lista carregada minutos antes.
 *
 * `null` quer dizer offline. Recusa é exceção, para a tela poder dizer "vocês
 * não são amigos" em vez de "essa pessoa está offline", que seria mentira.
 */
export async function locationOfFriend(meId: string, otherId: string): Promise<FriendLocation | null> {
  if (!(await areFriends(meId, otherId))) {
    throw new FriendshipError('NOT_FRIENDS', 'Só amigos veem onde você está.', 403);
  }
  if (await blockedBetween(meId, otherId)) {
    throw new FriendshipError('BLOCKED', 'Não é possível interagir com esta pessoa.', 403);
  }
  const record: PresenceRecord | null = presenceDirectory.locationOf(otherId);
  if (!record) return null;
  return {
    userId: otherId,
    sceneId: record.sceneId,
    roomId: record.roomId,
    kind: record.kind,
    since: record.since,
  };
}
