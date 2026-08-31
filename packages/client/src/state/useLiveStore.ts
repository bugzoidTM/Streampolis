import { create } from 'zustand';
import { FEED, PK, SUMMARY } from './mocks.js';
import type { CameraFraming, LiveCard, LiveRoomInfo, LiveSummary, PKState } from './types.js';

export type FeedFilter = 'all' | 'pk' | 'rising' | 'following';

interface LiveState {
  feed: LiveCard[];
  filter: FeedFilter;
  /** Live currently being watched, or null in world mode. */
  active: LiveCard | null;
  framing: CameraFraming;
  following: Set<string>;
  likes: number;
  /** Client-side burst counter; the server aggregates (SPECs §32). */
  likeBurst: number;
  pk: PKState | null;
  summary: LiveSummary | null;
  /**
   * A live em que este cliente REALMENTE está, vinda do estado da sala.
   * `active` continua sendo o cartão do feed (o que se clicou); este é o que o
   * servidor confirma — e é ele que a LiveView desenha.
   */
  room: LiveRoomInfo | null;

  setFilter: (f: FeedFilter) => void;
  /** TODO(network): joins the LiveRoom; the card is only the optimistic head. */
  enter: (liveId: string) => void;
  leave: () => void;
  setFraming: (f: CameraFraming) => void;
  toggleFollow: (hostId: string) => void;
  like: () => void;
  /** TODO(network): replace with the PK room's state patch. */
  applyPK: (pk: PKState | null) => void;
  setRoom: (room: LiveRoomInfo | null) => void;
}

export const useLiveStore = create<LiveState>((set, get) => ({
  feed: FEED,
  filter: 'all',
  active: FEED[0],
  framing: 'default',
  following: new Set(['u_dante']),
  likes: 18_902,
  likeBurst: 0,
  pk: PK,
  summary: SUMMARY,
  room: null,

  setFilter: (filter) => set({ filter }),
  enter: (liveId) => set({ active: get().feed.find((l) => l.liveId === liveId) ?? null, framing: 'default' }),
  leave: () => set({ active: null }),
  setFraming: (framing) => set({ framing }),
  toggleFollow: (hostId) => {
    const next = new Set(get().following);
    next.has(hostId) ? next.delete(hostId) : next.add(hostId);
    set({ following: next });
  },
  like: () => set({ likes: get().likes + 1, likeBurst: get().likeBurst + 1 }),
  applyPK: (pk) => set({ pk }),
  setRoom: (room) => set({ room }),
}));

export function visibleFeed(feed: LiveCard[], filter: FeedFilter, following: Set<string>): LiveCard[] {
  switch (filter) {
    case 'pk': return feed.filter((l) => l.isPK);
    case 'rising': return feed.filter((l) => l.badge === 'rising');
    case 'following': return feed.filter((l) => following.has(l.host.id));
    default: return feed;
  }
}
