import type { SceneId } from '@streampolis/shared';
import type { GameScene } from './GameScene.js';
import { PlazaScene } from './PlazaScene.js';
import { ApartmentScene } from './ApartmentScene.js';
import { LiveRoomScene } from './LiveRoomScene.js';
import { PkArenaScene } from './PkArenaScene.js';
import { AgencyScene, LobbyScene, StoreScene } from './PublicScenes.js';

/**
 * Scene registry.
 *
 * The world used to build a PlazaScene whatever room the server had put the
 * player in, which meant a live could be running in a room nobody could see.
 * Every scene id the protocol declares resolves to a real scene here, and the
 * table is exhaustive by type: adding a SceneId without a scene stops the
 * build instead of silently landing the player in the plaza.
 */
const SCENES: Record<SceneId, () => GameScene> = {
  central_plaza: () => new PlazaScene(),
  residential_lobby: () => new LobbyScene(),
  apartment: () => new ApartmentScene(),
  stream_store: () => new StoreScene(),
  agency_tower: () => new AgencyScene(),
  pk_arena: () => new PkArenaScene(),
  live_room: () => new LiveRoomScene(),
};

export function createScene(id: SceneId): GameScene {
  const make = SCENES[id];
  if (!make) {
    console.warn(`[scenes] cena desconhecida "${id}", caindo na praça`);
    return new PlazaScene();
  }
  return make();
}

export { PlazaScene, ApartmentScene, LiveRoomScene, PkArenaScene, LobbyScene, StoreScene, AgencyScene };
export type { GameScene };
