import { PLAY_AREA, type SceneId } from '../shared.js';

/**
 * Spawn ring per scene. Players arriving at the same instant must not stack on
 * the same coordinate — a ring keeps them apart without a collision solver on
 * the server (the client scene owns the real colliders).
 *
 * TODO(scenes agent): replace the radii with the real spawn markers exported
 * from packages/client/src/game/scenes once those land.
 */
const SPAWN_RADIUS: Record<SceneId, number> = {
  central_plaza: 6,
  residential_lobby: 3.5,
  apartment: 2.2,
  stream_store: 3,
  agency_tower: 4,
  pk_arena: 6,
  live_room: 2.5,
};

export interface SpawnPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  moving: boolean;
}

/** Deterministic: the same index always yields the same pose. */
export function spawnFor(sceneId: SceneId, index: number): SpawnPose {
  const r = SPAWN_RADIUS[sceneId] ?? 3;
  const golden = 2.399963229728653; // ~137.5°, spreads sequential joins evenly
  const angle = index * golden;
  const x = Math.cos(angle) * r;
  const z = Math.sin(angle) * r;
  const area = PLAY_AREA[sceneId];
  return {
    x: Math.min(Math.max(x, area.minX + 1), area.maxX - 1),
    y: 0,
    z: Math.min(Math.max(z, area.minZ + 1), area.maxZ - 1),
    // Face the centre of the scene, which is where the interesting things are.
    yaw: Math.atan2(-x, -z),
    moving: false,
  };
}
