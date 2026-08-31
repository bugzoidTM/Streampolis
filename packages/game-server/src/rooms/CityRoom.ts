import type { Client } from '@colyseus/core';
import { SCENES, type SceneId } from '../shared.js';
import type { AuthIdentity } from '../auth/AuthProvider.js';
import { config } from '../config.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { WorldState } from './schema.js';

const CITY_SCENES: ReadonlySet<SceneId> = new Set<SceneId>([
  'central_plaza', 'residential_lobby', 'stream_store', 'agency_tower',
]);

/**
 * Public walkable area (SPECs §17). One room per shard: when `central_plaza`
 * fills up the matchmaker creates central-plaza-002 instead of degrading the
 * first one, which is why capacity here is a hard ceiling and not a hint.
 */
export class CityRoom extends BaseWorldRoom<WorldState> {
  sceneId: SceneId = 'central_plaza';

  protected createState(): WorldState {
    return new WorldState();
  }

  override onCreate(options: RoomCreateOptions = {}): void {
    if (options.sceneId && CITY_SCENES.has(options.sceneId)) this.sceneId = options.sceneId;
    const scene = SCENES[this.sceneId];
    super.onCreate({ ...options, capacity: options.capacity ?? Math.min(scene.capacity, config.cityCapacity) });

    // filterBy('sceneId') matches on metadata, so this is what keeps a player
    // asking for the store out of a plaza shard.
    this.setMetadata({ sceneId: this.sceneId, name: scene.name });
  }

  protected override onPlayerJoined(_client: Client, identity: AuthIdentity): void {
    this.systemChat(`${identity.displayName} chegou.`);
  }

  protected override onPlayerLeft(_client: Client, identity: AuthIdentity): void {
    this.systemChat(`${identity.displayName} saiu.`);
  }
}
