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
/**
 * Opening a broadcast. There is no hostId here on purpose: the server reads it
 * from the authenticated session. A client that could name the host could open
 * a live in someone else's name.
 */
export interface GoLiveIntent { title: string; category: string; sceneId: SceneId }

/** Host offers a stage seat; the guest has to accept it (SPECs §17). */
export interface StageInviteIntent { userId: string }
export interface StageInvite { fromId: string; fromName: string; expiresAt: number }

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
  /** Colyseus room id — the key a viewer joins by (never a client-chosen one). */
  roomId: string;
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

// ---------------------------------------------------------------------------
// Movement contract (added by the multiplayer agent).
// Everything below is shared *on purpose*: the server integrator and the client
// predictor must be the same function, or reconciliation oscillates forever.
// ---------------------------------------------------------------------------

/** One simulation step, in seconds. Intents are fixed-step, never wall-clock. */
export const TICK_MS = 1000 / TICK_HZ;
export const FIXED_DT = 1 / TICK_HZ;

/**
 * Cap on intents consumed per server tick. A client running at TICK_HZ produces
 * one per tick; the slack absorbs jitter. Anything beyond is dropped, which is
 * what stops a speed hack from simply sending 500 intents per second.
 */
export const MAX_INTENTS_PER_TICK = 3;
/** Queue depth kept per player. Older intents are discarded, not replayed. */
export const INTENT_QUEUE_LIMIT = 12;

export interface Bounds {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
}

/**
 * Server-side movement clamp per scene (SPECs §21, "área permitida").
 * TODO(scenes agent): keep in sync with the real collision volumes in
 * packages/client/src/game/scenes — these are conservative rectangles.
 */
export const PLAY_AREA: Record<SceneId, Bounds> = {
  central_plaza:     { minX: -62, maxX: 62, minZ: -62, maxZ: 62 },
  residential_lobby: { minX: -14, maxX: 14, minZ: -14, maxZ: 14 },
  apartment:         { minX: -8,  maxX: 8,  minZ: -8,  maxZ: 8 },
  stream_store:      { minX: -12, maxX: 12, minZ: -12, maxZ: 12 },
  agency_tower:      { minX: -16, maxX: 16, minZ: -16, maxZ: 16 },
  pk_arena:          { minX: -18, maxX: 18, minZ: -18, maxZ: 18 },
  live_room:         { minX: -10, maxX: 10, minZ: -10, maxZ: 10 },
};

export interface Kinematic {
  x: number;
  z: number;
  yaw: number;
  moving: boolean;
}

/**
 * Integrates one MoveIntent over one fixed step and clamps to the play area.
 * Pure and deterministic — the same inputs must give bit-identical outputs on
 * both sides, so no Math.random, no Date.now, no wall-clock dt.
 */
export function applyMoveIntent(from: Kinematic, intent: MoveIntent, area: Bounds): Kinematic {
  const len = Math.hypot(intent.dx, intent.dz);
  const yaw = clampYaw(intent.yaw);
  if (!Number.isFinite(len) || len < 1e-4) {
    return { x: from.x, z: from.z, yaw, moving: false };
  }
  // Magnitude above 1 is a client lying about its analog stick; clamp, not reject.
  const throttle = Math.min(1, len);
  const speed = intent.run ? MAX_SPEED.run : MAX_SPEED.walk;
  const step = throttle * speed * FIXED_DT;
  const x = clamp(from.x + (intent.dx / len) * step, area.minX, area.maxX);
  const z = clamp(from.z + (intent.dz / len) * step, area.minZ, area.maxZ);
  return { x, z, yaw, moving: true };
}

/** Largest displacement a single legitimate tick may produce, with slack. */
export function maxStepDistance(): number {
  return MAX_SPEED.run * MAX_SPEED.tolerance * FIXED_DT;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalises to (-PI, PI]; also scrubs NaN/Infinity coming off the wire. */
export function clampYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const twoPi = Math.PI * 2;
  let y = yaw % twoPi;
  if (y > Math.PI) y -= twoPi;
  if (y <= -Math.PI) y += twoPi;
  return y;
}

// ---- server -> client, movement reconciliation ----

/**
 * Authoritative pose echoed back with the last intent the server consumed.
 * The client replays every still-pending intent on top of this (SPECs §18).
 */
export interface MoveCorrection {
  seq: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Set when the server had to reject or clamp — the client must hard-reset. */
  corrected: boolean;
}

// ---- other client -> server intents ----

export interface LikeIntent { count: number }
export interface StartPKIntent { opponentId: string; opponentName: string }

// ---- other server -> client events ----

export interface LikeTotals { total: number; delta: number }
export interface FollowEvent { followerId: string; followerName: string; timestamp: number }
export interface SystemNotice { code: string; text: string }

/**
 * Message names on the wire. Both sides import these instead of typing the
 * string twice — a typo here is a silent no-op that costs an afternoon.
 */
export const MSG = {
  // client -> server
  move: 'move',
  chat: 'chat',
  emote: 'emote',
  gift: 'gift',
  like: 'like',
  goLive: 'goLive',
  endLive: 'endLive',
  startPK: 'startPK',
  invite: 'invite',
  acceptStage: 'acceptStage',
  leaveStage: 'leaveStage',
  mute: 'mute',
  block: 'block',
  /**
   * "Troquei de roupa": o cliente reapresenta o TOKEN NOVO que a API assinou
   * depois de validar a peça contra o inventário. A aparência continua vindo
   * assinada, como no join — o navegador nunca manda `avatar`.
   */
  restyle: 'restyle',
  /**
   * "Acabei de redecorar": o DONO avisa que a planta da casa mudou, e a sala
   * relê a lista na API. O navegador não manda os móveis — ele nunca mandou, e
   * não é por descuido: quem decide onde o sofá cabe é a API, que confere posse
   * e sobreposição (SPECs §68). O aviso é só isto: vá perguntar de novo.
   */
  redecorate: 'redecorate',
  // server -> client
  correction: 'correction',
  chatMessage: 'chatMessage',
  giftEvent: 'giftEvent',
  likeTotals: 'likeTotals',
  follow: 'follow',
  notice: 'notice',
  pkResult: 'pkResult',
  stageInvite: 'stageInvite',
} as const;

export type ClientMessage = typeof MSG[keyof typeof MSG];

/** Result of a finished PK battle. Produced by the server, exactly once. */
export interface PKResult {
  battleId: string;
  winnerId: string;
  loserId: string;
  scoreA: number;
  scoreB: number;
  draw: boolean;
  finishedAt: number;
}
