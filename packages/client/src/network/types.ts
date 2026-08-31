import type { AnimState, AvatarConfig, PKPhase, SceneId } from '@streampolis/shared';

/**
 * Read-only view of the server's Colyseus schema.
 *
 * The browser decodes state by reflection, so it never imports the server's
 * schema classes — these interfaces are the shape contract instead. Keep them
 * in step with packages/game-server/src/rooms/schema.ts; a field renamed there
 * and not here is a silent `undefined`, not a compile error.
 */

export interface MapLike<V> {
  readonly size: number;
  get(key: string): V | undefined;
  forEach(cb: (value: V, key: string) => void): void;
}

export interface PlayerView {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
  moving: boolean;
  gifterLevel: number;
  agency: string;
  role: 'visitor' | 'owner' | 'host' | 'cohost' | 'spectator';
  avatar: AvatarConfig;
}

export interface WorldStateView {
  sceneId: SceneId;
  shard: string;
  tick: number;
  players: MapLike<PlayerView>;
}

export interface PKView {
  phase: PKPhase;
  hostA: string;
  hostB: string;
  nameA: string;
  nameB: string;
  scoreA: number;
  scoreB: number;
  endsAt: number;
  winnerId: string;
}

export interface LiveStateView extends WorldStateView {
  liveId: string;
  hostId: string;
  hostName: string;
  title: string;
  category: string;
  isPK: boolean;
  ended: boolean;
  startedAt: number;
  viewers: number;
  likes: number;
  coinsReceived: number;
  agency: string;
  pk: PKView;
}

/** Pose the renderer draws this frame — interpolated or predicted, never raw. */
export interface RenderPose {
  id: string;
  sessionId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
  moving: boolean;
  gifterLevel: number;
  avatar: AvatarConfig;
  isLocal: boolean;
}
