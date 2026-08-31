/**
 * View models consumed by the React layer.
 *
 * These are the UI's contract, not the wire format. Whoever owns `network/`
 * and `packages/api` maps server payloads into these shapes; the UI never
 * reads a Colyseus schema or an HTTP body directly, so a protocol change stays
 * a one-file adapter change instead of a rewrite of every screen.
 */
import type { AvatarConfig, Needs, PKPhase, PlayerStats, Wallet } from '@streampolis/shared';

/** Anyone rendered as a person: portrait + name + prestige. */
export interface PersonRef {
  id: string;
  name: string;
  handle: string;
  /** Drives the procedural portrait until the 3D head render lands. */
  avatar: AvatarConfig;
  /** Raw gifter XP — the badge tier is derived, never stored twice. */
  gifterXp: number;
  agency?: string | null;
  verified?: boolean;
}

// ---------------------------------------------------------------- chat

export type ChatMessageKind = 'user' | 'system' | 'gift' | 'join' | 'follow';

export interface ChatMessage {
  id: string;
  kind: ChatMessageKind;
  /** Absent on system lines. */
  sender?: PersonRef;
  text: string;
  ts: number;
  /** Set on `gift` lines so the row can show the catalog colour. */
  giftId?: string;
  quantity?: number;
  /** The server accepted it but moderation replaced the body (SPECs §39). */
  filtered?: boolean;
}

/** Mirrors the server-side limiter (SPECs §31) so the input can show it. */
export interface ChatRateLimit {
  /** Messages still allowed inside the current window. */
  remaining: number;
  capacity: number;
  /** Epoch ms when the bucket refills; 0 when it is already full. */
  resetAt: number;
  maxLength: number;
  /** Set while the player is muted by moderation. */
  mutedUntil?: number;
}

// ---------------------------------------------------------------- live

export type LiveCategory =
  | 'Bate-papo' | 'Música' | 'Dança' | 'Jogos' | 'Beleza' | 'Evento' | 'PK';

export type LiveBadge = 'none' | 'rising' | 'partner' | 'event';

export interface LiveCard {
  liveId: string;
  host: PersonRef;
  title: string;
  category: LiveCategory;
  /** Real connected clients (PRD §11) — never an inflated number. */
  realViewers: number;
  isPK: boolean;
  agency: string | null;
  badge: LiveBadge;
  startedAt: number;
  /** Stable per-live hue so the placeholder scene art does not flicker. */
  hue: number;
}

/** Camera presets the spectator can pick (PRD §12). */
export type CameraFraming = 'default' | 'close' | 'full' | 'room';

// ---------------------------------------------------------------- PK

export interface PKSide {
  streamer: PersonRef;
  score: number;
  topGifter: { name: string; coins: number } | null;
}

export interface PKState {
  phase: PKPhase;
  a: PKSide;
  b: PKSide;
  /** Milliseconds left in the current phase. */
  msRemaining: number;
  winner: 'a' | 'b' | 'draw' | null;
}

// ---------------------------------------------------------------- summaries

export interface GiftTally {
  giftId: string;
  quantity: number;
  coins: number;
}

/** End-of-live report (PRD §10). */
export interface LiveSummary {
  title: string;
  category: LiveCategory;
  durationMs: number;
  uniqueViewers: number;
  peakViewers: number;
  newFollowers: number;
  messages: number;
  likes: number;
  gifts: GiftTally[];
  creatorPoints: number;
  fameGained: number;
  /** Personal bests broken this session, shown as a highlight strip. */
  records: string[];
}

// ---------------------------------------------------------------- profile

export interface ProfileBadge {
  id: string;
  label: string;
  color: string;
  /** Short reason, shown on hover/long-press. */
  hint: string;
}

export interface ProfileVM {
  person: PersonRef;
  bio: string;
  fame: number;
  followers: number;
  following: number;
  streamerRank: number | null;
  badges: ProfileBadge[];
  stats: { label: string; value: string }[];
  /** Item ids from `packages/shared/src/items.ts`. */
  collection: string[];
  apartmentPublic: boolean;
  isSelf: boolean;
  isFollowing: boolean;
}

// ---------------------------------------------------------------- rankings

export type RankingBoard = 'streamers' | 'gifters' | 'pk' | 'agencies';
export type RankingRange = 'today' | 'week' | 'season';

export interface RankingRow {
  id: string;
  rank: number;
  /** Positions gained since the previous snapshot; 0 = unchanged. */
  delta: number;
  name: string;
  subtitle: string;
  value: number;
  /** Absent for agencies, which draw a crest instead of a portrait. */
  avatar?: AvatarConfig;
  gifterXp?: number;
  isSelf?: boolean;
}

// ---------------------------------------------------------------- misc

export interface Mission {
  id: string;
  label: string;
  done: boolean;
  reward: string;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export type { AvatarConfig, Needs, PlayerStats, Wallet };
