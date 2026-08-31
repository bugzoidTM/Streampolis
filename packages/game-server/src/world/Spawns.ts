import { SCENE_SPAWNS, PLAY_AREA, type SceneId } from '../shared.js';

/**
 * Where a joining player lands.
 *
 * The markers themselves live in @streampolis/shared, next to the layout that
 * places the furniture, because the client predicts movement from the spawn
 * the server assigned: a ring invented here and a floor plan authored there
 * differ by exactly one sofa, and the player arrives inside it.
 */

export interface SpawnPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  moving: boolean;
}

/** Deterministic: the same index always yields the same pose. */
export function spawnFor(sceneId: SceneId, index: number): SpawnPose {
  const markers = SCENE_SPAWNS[sceneId] ?? SCENE_SPAWNS.central_plaza;
  const marker = markers[((index % markers.length) + markers.length) % markers.length];
  const area = PLAY_AREA[sceneId];
  return {
    x: Math.min(Math.max(marker.x, area.minX + 1), area.maxX - 1),
    y: 0,
    z: Math.min(Math.max(marker.z, area.minZ + 1), area.maxZ - 1),
    yaw: marker.yaw,
    moving: false,
  };
}
