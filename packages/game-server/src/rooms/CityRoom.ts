import type { Client } from '@colyseus/core';
import { SCENES, type SceneId } from '../shared.js';
import type { AuthIdentity } from '../auth/AuthProvider.js';
import { config } from '../config.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { CityMemberState, CityState, type PlayerState } from './schema.js';
import { CityInterest } from '../world/CityInterest.js';

const CITY_SCENES: ReadonlySet<SceneId> = new Set<SceneId>([
  'central_plaza', 'residential_lobby', 'stream_store', 'agency_tower',
]);

/**
 * Public walkable area (SPECs §17). One room per shard: when `central_plaza`
 * fills up the matchmaker creates central-plaza-002 instead of degrading the
 * first one, which is why capacity here is a hard ceiling and not a hint.
 */
export class CityRoom extends BaseWorldRoom<CityState> {
  sceneId: SceneId = 'central_plaza';
  private readonly interest = new CityInterest(config.cityAoiRadius, config.cityAoiLeaveRadius);

  protected createState(): CityState {
    return new CityState();
  }

  override onCreate(options: RoomCreateOptions = {}): void {
    if (options.sceneId && CITY_SCENES.has(options.sceneId)) this.sceneId = options.sceneId;
    const scene = SCENES[this.sceneId];
    // Matchmaking forwards browser options into onCreate. Only the scene and
    // operator configuration may set this ceiling; a client must not expand
    // the shard (and its quadratic AOI work) by submitting capacity: 100000.
    super.onCreate({ ...options, capacity: Math.min(scene.capacity, config.cityCapacity) });

    // filterBy('sceneId') matches on metadata, so this is what keeps a player
    // asking for the store out of a plaza shard.
    this.setMetadata({ sceneId: this.sceneId, name: scene.name });
  }

  protected override onPlayerJoined(client: Client, identity: AuthIdentity, player: PlayerState): void {
    this.state.members.set(client.sessionId, new CityMemberState().apply(player));
    // Initialize all views before the new client's full state is encoded.
    this.interest.update(this.clients, this.state.players);
    this.systemChat(`${identity.displayName} chegou.`);
  }

  protected override onPlayerRemoving(sessionId: string, player: PlayerState): void {
    this.interest.remove(this.clients, player);
    this.state.members.delete(sessionId);
  }

  protected override onAppearanceChanged(client: Client, player: PlayerState): void {
    this.state.members.get(client.sessionId)?.apply(player);
  }

  protected override onTick(): void {
    this.interest.update(this.clients, this.state.players);
  }

  protected override onPlayerLeft(_client: Client, identity: AuthIdentity): void {
    this.systemChat(`${identity.displayName} saiu.`);
  }
}
