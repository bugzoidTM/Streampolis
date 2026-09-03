import { ServerError, type Client } from '@colyseus/core';
import {
  MSG, PLACEABLES, SCENE_COLLIDERS, placementColliders,
  type Collider, type HomePlacement, type SceneId,
} from '../shared.js';
import { AuthError, type AuthIdentity } from '../auth/AuthProvider.js';
import { defaultApiGateway, type ApiGateway, type HomeSnapshot } from '../api/ApiGateway.js';
import { config } from '../config.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { ApartmentState, PlacedItem, type RoomRole } from './schema.js';

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
    this.publishDecor(home.decor);
    this.setMetadata({ sceneId: this.sceneId, apartmentId, ownerId: home.ownerId });
  }

  /**
   * A mobília do dono, como ESTADO da sala.
   *
   * Ela chega da API com posição — foi para isso que `getHome` passou a
   * carregar `HomePlacement` inteiro em vez de uma lista de ids. Publicá-la no
   * estado é o que dá a MESMA mesa de colisão às duas autoridades: o preditor
   * do cliente lê daqui e o `colliders()` abaixo lê da mesma lista. Ler a
   * decoração pela API no navegador serve para DESENHAR; para colidir, a
   * palavra é da sala.
   *
   * Peça que este build não conhece é descartada, e não desenhada torta: sem
   * `PLACEABLES` não há nem geometria nem meia-extensão para ela.
   */
  private publishDecor(list: readonly HomePlacement[]): void {
    this.state.decor.splice(0, this.state.decor.length);
    for (const p of list) {
      if (!PLACEABLES[p.itemId]) continue;
      this.state.decor.push(new PlacedItem().apply(p));
    }
  }

  /** A planta do estúdio MAIS a mobília que o dono pôs nele. */
  protected override colliders(): readonly Collider[] {
    return [...SCENE_COLLIDERS[this.sceneId], ...placementColliders([...this.state.decor])];
  }

  protected override onRoomCreated(options: RoomCreateOptions): void {
    super.onRoomCreated(options);
    // "Redecorei": o dono avisa, a sala RELÊ da API. O navegador não manda os
    // móveis — quem confere posse, encaixe e sobreposição é a API (SPECs §68),
    // e uma sala que aceitasse a lista do cliente seria uma sala em que o sofá
    // vai para dentro da parede porque o cliente disse que vai.
    this.onMessage(MSG.redecorate, (client) => {
      void this.reloadDecor(client);
    });
  }

  private async reloadDecor(client: Client): Promise<void> {
    const home = this.home;
    const identity = this.identityOf(client);
    if (!home || !identity || identity.userId !== home.ownerId) return;

    const fresh = await this.api.getHome(home.apartmentId);
    // API fora do ar: a mobília de antes continua valendo. Esvaziar a sala
    // porque uma chamada falhou seria transformar um erro de rede em mudança.
    if (!fresh) return;
    this.home = fresh;
    this.publishDecor(fresh.decor);
    this.refreshColliders();
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
