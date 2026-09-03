import {
  DEFAULT_AVATAR,
  GIFTER_TIERS,
  GIFT_BY_ID,
  PK_DURATION_MS,
  type AvatarConfig,
  type ChatMessage as WireChat,
  type GiftEvent,
} from '@streampolis/shared';
import { useChatStore } from '../state/useChatStore.js';
import { useLiveStore } from '../state/useLiveStore.js';
import { useRoomStore, type RoomPerson } from '../state/useRoomStore.js';
import type { ChatMessage, PersonRef, PKSide, PKState } from '../state/types.js';
import type { LiveStateView, PKView, WorldStateView } from './types.js';
import type { AnyWorldConnection } from './WorldConnection.js';

/**
 * Adapter between the wire and the UI's view models.
 *
 * The stores were written against mocks on purpose (see their TODO(network)
 * markers); this is the one file that knows both shapes. A protocol change
 * stops here instead of rippling into every screen.
 */

const MAX_BUFFER = 200;

/** Wire messages carry a tier, not XP. Rebuild the floor XP of that tier. */
function xpFloorFor(level: number): number {
  const tier = GIFTER_TIERS[Math.max(0, Math.min(level, GIFTER_TIERS.length - 1))];
  return tier ? tier.xp : 0;
}

function personFrom(
  state: WorldStateView | undefined,
  userId: string,
  name: string,
  gifterLevel: number,
): PersonRef {
  // Spectators have no body in a live room, so their look is simply unknown
  // here — the portrait falls back to the default until the API's profile
  // endpoint can be asked for it.
  let avatar: AvatarConfig = DEFAULT_AVATAR;
  let agency: string | null = null;
  state?.players?.forEach((player) => {
    if (player.id !== userId) return;
    avatar = player.avatar;
    agency = player.agency || null;
  });
  return {
    id: userId,
    name,
    handle: `@${userId.slice(0, 12)}`,
    avatar,
    gifterXp: xpFloorFor(gifterLevel),
    agency,
  };
}

function pushChat(message: ChatMessage): void {
  const { messages } = useChatStore.getState();
  useChatStore.setState({ messages: [...messages, message].slice(-MAX_BUFFER) });
}

function giftLine(state: WorldStateView | undefined, event: GiftEvent): ChatMessage {
  const gift = GIFT_BY_ID.get(event.giftId);
  const label = gift ? gift.name : event.giftId;
  return {
    id: `gift_${event.eventId}`,
    kind: 'gift',
    sender: personFrom(state, event.senderId, event.senderName, event.gifterLevel),
    text: event.quantity > 1 ? `enviou ${label} x${event.quantity}` : `enviou ${label}`,
    ts: event.timestamp,
    giftId: event.giftId,
    quantity: event.quantity,
  };
}

function toChat(state: WorldStateView | undefined, wire: WireChat): ChatMessage {
  if (wire.system) {
    return { id: wire.id, kind: 'system', text: wire.text, ts: wire.timestamp };
  }
  return {
    id: wire.id,
    kind: 'user',
    sender: personFrom(state, wire.senderId, wire.senderName, wire.gifterLevel),
    text: wire.text,
    ts: wire.timestamp,
  };
}

function side(state: WorldStateView | undefined, id: string, name: string, score: number): PKSide {
  return {
    // The badge level is unknown for a host that is not on this client's
    // stage; zero is the honest default, not a guess.
    streamer: personFrom(state, id, name || 'Host', 0),
    score,
    topGifter: null,
  };
}

export function toPKState(state: WorldStateView | undefined, pk: PKView): PKState | null {
  if (pk.phase === 'WAITING') return null;
  const remaining = Math.max(0, pk.endsAt - Date.now());
  return {
    phase: pk.phase,
    a: side(state, pk.hostA, pk.nameA, pk.scoreA),
    b: side(state, pk.hostB, pk.nameB, pk.scoreB),
    msRemaining: pk.phase === 'FINISHED' ? 0 : Math.min(remaining, PK_DURATION_MS),
    winner: pk.phase !== 'FINISHED' ? null
      : pk.winnerId === '' ? 'draw'
      : pk.winnerId === pk.hostA ? 'a' : 'b',
  };
}

function isLiveState(state: WorldStateView): state is LiveStateView {
  return typeof (state as LiveStateView).liveId === 'string';
}

/**
 * Points a connection at the stores and returns the detach function. Clears
 * the mock chat on attach: two sources of truth in the same list is worse than
 * an empty one.
 */
/**
 * Quem está na sala, na ordem em que a lista deve ser lida.
 *
 * Anfitrião e co-anfitrião primeiro (numa live, são eles o assunto), o próprio
 * jogador logo depois, e o resto por nome — ordenar por sessionId faria a lista
 * embaralhar sozinha a cada reconexão de alguém.
 */
function rosterOf(state: WorldStateView | undefined, meSessionId: string): RoomPerson[] {
  const out: RoomPerson[] = [];
  state?.players?.forEach((player, sessionId) => {
    out.push({
      userId: player.id,
      sessionId,
      name: player.name,
      gifterLevel: player.gifterLevel,
      gifterXp: xpFloorFor(player.gifterLevel),
      agency: player.agency || null,
      role: player.role,
      isSelf: sessionId === meSessionId,
      avatar: player.avatar,
    });
  });
  const peso = (p: RoomPerson) =>
    (p.role === 'host' ? 0 : p.role === 'cohost' ? 1 : p.isSelf ? 2 : 3);
  return out.sort((a, b) => peso(a) - peso(b) || a.name.localeCompare(b.name));
}

export function attachStores(connection: AnyWorldConnection): () => void {
  useChatStore.setState({ messages: [] });
  useLiveStore.setState({ room: null });
  useRoomStore.getState().clear();

  const offs = [
    connection.on('chat', (wire) => pushChat(toChat(connection.state, wire))),

    connection.on('gift', (event) => pushChat(giftLine(connection.state, event))),

    connection.on('likes', (totals) => {
      // The server's running total wins; the local burst counter is only the
      // animation's fuel (SPECs §32).
      useLiveStore.setState({ likes: totals.total });
    }),

    connection.on('follow', (event) => {
      pushChat({
        id: `follow_${event.followerId}_${event.timestamp}`,
        kind: 'follow',
        text: `${event.followerName} começou a seguir`,
        ts: event.timestamp,
      });
    }),

    connection.on('notice', (notice) => {
      pushChat({
        id: `notice_${notice.code}_${Date.now()}`,
        kind: 'system',
        text: notice.text,
        ts: Date.now(),
      });
    }),

    connection.on('state', (state) => {
      // A lista de presentes vale para TODA sala — praça, apartamento, live —,
      // e por isso é lida antes do desvio para o estado de live.
      //
      // A assinatura é o que impede o painel de redesenhar vinte vezes por
      // segundo: o patch que chega a cada tick é quase todo posição, e a
      // composição da sala muda uma vez a cada muitos minutos.
      const people = rosterOf(state, connection.sessionId);
      const signature = people
        .map((p) => `${p.sessionId}:${p.name}:${p.role}:${p.gifterLevel}`)
        .join('|');
      if (signature !== useRoomStore.getState().signature) {
        useRoomStore.getState().setPeople(people, signature);
      }

      if (!isLiveState(state)) return;
      const me = state.players?.get(connection.sessionId);
      useLiveStore.setState({
        likes: state.likes,
        pk: toPKState(state, state.pk),
        // O que a LiveView desenha vem daqui: título, host, espectadores e fim
        // da transmissão são estado do servidor, nunca palpite do cliente.
        room: {
          liveId: state.liveId,
          hostId: state.hostId,
          hostName: state.hostName,
          title: state.title,
          category: state.category,
          viewers: state.viewers,
          likes: state.likes,
          isPK: state.isPK,
          ended: state.ended,
          startedAt: state.startedAt,
          role: me?.role === 'host' || me?.role === 'cohost' ? me.role : 'spectator',
        },
      });
    }),
  ];

  return () => {
    for (const off of offs) off();
    useRoomStore.getState().clear();
  };
}
