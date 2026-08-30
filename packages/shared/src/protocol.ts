import type { AnimState, AvatarConfig, PKPhase, SceneId } from './types.js';

/**
 * Wire protocol. The client sends *intent*; the server owns truth
 * (SPECs §16, §21, §38). Nothing here carries a balance the client computed.
 */

// ---- client -> server ----
export interface MoveIntent {
  /** Normalised planar direction, magnitude 0..1. */
  dx: number;
  dz: number;
  /** Facing in radians; purely cosmetic, still clamped server-side. */
  yaw: number;
  run: boolean;
  /** Client sequence number, echoed back for reconciliation. */
  seq: number;
}

export interface ChatIntent { text: string }
export interface EmoteIntent { anim: AnimState }
export interface GiftIntent {
  giftId: string;
  quantity: number;
  /** Required for exactly-once semantics (SPECs §27). */
  idempotencyKey: string;
}
export interface GoLiveIntent { title: string; category: string; sceneId: SceneId }

// ---- server -> client ----
export interface PlayerSnapshot {
  id: string;
  name: string;
  x: number; y: number; z: number;
  yaw: number;
  anim: AnimState;
  moving: boolean;
  avatar: AvatarConfig;
  gifterLevel: number;
  agency: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  gifterLevel: number;
  timestamp: number;
  system?: boolean;
}

/** Transient — never the source of truth for money (SPECs §30). */
export interface GiftEvent {
  eventId: string;
  senderId: string;
  senderName: string;
  gifterLevel: number;
  giftId: string;
  quantity: number;
  animationId: string;
  receiverId: string;
  pkPoints: number;
  timestamp: number;
}

export interface PKState {
  phase: PKPhase;
  hostA: string; hostB: string;
  nameA: string; nameB: string;
  scoreA: number; scoreB: number;
  /** Server-authoritative deadline as an epoch ms. Clients only render it. */
  endsAt: number;
  winnerId: string;
}

export interface LiveSummary {
  liveId: string;
  hostId: string;
  hostName: string;
  title: string;
  category: string;
  realViewers: number;
  isPK: boolean;
  agency: string;
  startedAt: number;
}

export const MAX_CHAT_LEN = 200;
export const CHAT_RATE_LIMIT = { messages: 5, windowMs: 5_000 };
export const LIKE_RATE_LIMIT = { likes: 20, windowMs: 5_000 };
/** Server movement validation ceiling in m/s (SPECs §21). */
export const MAX_SPEED = { walk: 2.4, run: 5.2, tolerance: 1.35 };
export const TICK_HZ = 24;
