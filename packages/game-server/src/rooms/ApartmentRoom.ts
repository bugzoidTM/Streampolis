import { ServerError, type Client } from '@colyseus/core';
import { ITEM_BY_ID, type SceneId } from '../shared.js';
import { AuthError, type AuthIdentity } from '../auth/AuthProvider.js';
import { defaultApiGateway, type ApiGateway, type HomeSnapshot } from '../api/ApiGateway.js';
import { config } from '../config.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { ApartmentState, type RoomRole } from './schema.js';

/**
 * What the browser may say to enter a home: WHICH home.
 *
 * It used to send ownerId, ownerName, decor and visibility, which is the same
 * as letting a visitor declare "this apartment is mine, these are its furniture
 * and it is open to everyone". Ownership, contents and privacy now come from
 * the API — the room only carries the key.
 */
export interface ApartmentOptions extends RoomCreateOptions {
  token?: string;
  apartmentId?: string;
}

/**
 * A player's home (PRD §8). Owner plus guests, and it is live-capable — the
 * MVP's "Go Live" happens here before the dedicated stage exists.
 */
export class ApartmentRoom extends BaseWorldRoom<ApartmentState> {
  sceneId: SceneId = 'apartment';

  private readonly api: ApiGateway = defaultApiGateway();
  private home: HomeSnapshot | null = null;

  protected createState(): ApartmentState {
    return new ApartmentState();
  }

  override async onCreate(options: ApartmentOptions = {}): Promise<void> {
    // The creator has to be authenticated even to open the room: an anonymous
    // create would let anyone spin up a room keyed to someone's apartment.
    try {
      await this.auth.authenticate(options.token ?? '');
    } catch (err) {
      throw new ServerError(401, err instanceof AuthError ? err.code : 'auth_failed');
    }

    const apartmentId = typeof options.apartmentId === 'string' ? options.apartmentId : '';
    if (!apartmentId) throw new ServerError(400, 'apartment_id_required');

    const home = await this.api.getHome(apartmentId);
    if (!home) throw new ServerError(404, 'apartment_not_found');
    this.home = home;

    super.onCreate({ ...options, capacity: config.apartmentCapacity });

    this.state.ownerId = home.ownerId;
    this.state.ownerName = home.ownerName;
    for (const id of home.decor) {
      // Unknown ids are dropped rather than rendered: the client has no mesh
      // for an item this build does not ship.
      if (ITEM_BY_ID.has(id)) this.state.decor.push(id);
    }
    this.setMetadata({ sceneId: this.sceneId, apartmentId, ownerId: home.ownerId });
  }

  /**
   * Privacy is the API's answer, not the room's guess. Fail closed: when the
   * API cannot be reached, `canEnterHome` returns false and the door stays shut.
   */
  override async onAuth(client: Client, options: ApartmentOptions): Promise<AuthIdentity> {
    const identity = await super.onAuth(client, options);
    const home = this.home;
    if (!home) throw new ServerError(503, 'apartment_unavailable');
    if (identity.userId === home.ownerId) return identity;
    if (!(await this.api.canEnterHome(home.apartmentId, identity.userId))) {
      throw new ServerError(403, 'apartment_private');
    }
    return identity;
  }

  protected override roleFor(identity: AuthIdentity): RoomRole {
    return identity.userId === this.home?.ownerId ? 'owner' : 'visitor';
  }
}
