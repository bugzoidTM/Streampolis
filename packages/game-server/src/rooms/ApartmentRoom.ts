import { ServerError, type Client } from '@colyseus/core';
import { ITEM_BY_ID, type SceneId } from '../shared.js';
import type { AuthIdentity } from '../auth/AuthProvider.js';
import { config } from '../config.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { ApartmentState, type RoomRole } from './schema.js';

export interface ApartmentOptions extends RoomCreateOptions {
  ownerId?: string;
  ownerName?: string;
  /** Item ids the API says this apartment currently has placed (PRD §8). */
  decor?: string[];
  /** Private apartments only accept the owner; open ones accept visitors. */
  visibility?: 'open' | 'friends' | 'private';
}

/**
 * A player's home (SPECs §17). Owner plus guests, and it is live-capable —
 * the MVP's "Go Live" happens here before the dedicated stage exists.
 *
 * The decor list is a projection of what the API stored. The room never
 * invents an item and never persists one: a client that sends a decor change
 * is only allowed to reorder what it already owns, and the API is what will
 * write it (TODO(api agent): PUT /apartments/:id/decor, then drop this echo).
 */
export class ApartmentRoom extends BaseWorldRoom<ApartmentState> {
  sceneId: SceneId = 'apartment';

  private ownerId = '';
  private visibility: ApartmentOptions['visibility'] = 'open';

  protected createState(): ApartmentState {
    return new ApartmentState();
  }

  override onCreate(options: ApartmentOptions = {}): void {
    this.ownerId = typeof options.ownerId === 'string' ? options.ownerId : '';
    this.visibility = options.visibility ?? 'open';
    super.onCreate({ ...options, capacity: config.apartmentCapacity });

    this.state.ownerId = this.ownerId;
    this.state.ownerName = options.ownerName ?? '';
    for (const id of options.decor ?? []) {
      if (ITEM_BY_ID.has(id)) this.state.decor.push(id);
    }
    this.setMetadata({ sceneId: this.sceneId, ownerId: this.ownerId, visibility: this.visibility });
  }

  override onJoin(client: Client, options: Record<string, unknown> = {}, auth?: AuthIdentity): void {
    const identity = auth ?? (client.auth as AuthIdentity);
    if (this.visibility === 'private' && identity?.userId !== this.ownerId) {
      throw new ServerError(403, 'apartment_private');
    }
    super.onJoin(client, options, auth);
  }

  protected override roleFor(identity: AuthIdentity): RoomRole {
    return identity.userId === this.ownerId ? 'owner' : 'visitor';
  }
}
