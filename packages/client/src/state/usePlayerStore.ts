import { create } from 'zustand';
import { DEFAULT_AVATAR, type AvatarConfig, type Needs, type PlayerStats, type Wallet } from '@streampolis/shared';
import { OWNED_ITEMS, PEOPLE } from './mocks.js';
import type { Mission, PersonRef } from './types.js';
import { MISSIONS } from './mocks.js';

interface PlayerState {
  me: PersonRef;
  wallet: Wallet;
  needs: Needs;
  stats: PlayerStats;
  /** Committed look. */
  avatar: AvatarConfig;
  /** Uncommitted edits inside the creator; discarded on cancel. */
  draft: AvatarConfig;
  owned: Set<string>;
  missions: Mission[];

  patchDraft: (patch: Partial<AvatarConfig>) => void;
  resetDraft: () => void;
  commitDraft: () => void;

  /**
   * Applied only after the server echoes the mutation.
   * TODO(network): call from the wallet/profile subscription; the client is
   * never authoritative over money or inventory (SPECs §68 regra 6).
   */
  applyServerState: (s: Partial<Pick<PlayerState, 'wallet' | 'needs' | 'stats' | 'avatar' | 'owned'>>) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  me: PEOPLE.me,
  wallet: { credits: 12_480, coins: 3_205 },
  needs: { energy: 62, social: 88, mood: 74, comfort: 41 },
  stats: {
    level: 17, xp: 6_420, fame: 24_180, gifterXp: PEOPLE.me.gifterXp,
    gifterLevel: 3, creatorPoints: 118_400, followersCount: 2_914,
  },
  avatar: PEOPLE.me.avatar ?? DEFAULT_AVATAR,
  draft: PEOPLE.me.avatar ?? DEFAULT_AVATAR,
  owned: OWNED_ITEMS,
  missions: MISSIONS,

  patchDraft: (patch) => set({ draft: { ...get().draft, ...patch } }),
  resetDraft: () => set({ draft: get().avatar }),
  // TODO(api): POST /me/avatar and only then trust the result; this optimistic
  // commit exists so the lab can be driven without a backend.
  commitDraft: () => set({ avatar: get().draft }),

  applyServerState: (s) => set(s as Partial<PlayerState>),
}));

/** XP needed to reach the next level — placeholder curve until the API ships. */
export function xpForNextLevel(level: number): number {
  return Math.round(400 * Math.pow(level, 1.35));
}
