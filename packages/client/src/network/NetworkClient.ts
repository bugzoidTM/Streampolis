import { Client } from 'colyseus.js';
import type { LiveSummary, SceneId } from '@streampolis/shared';
import { WorldConnection } from './WorldConnection.js';
import type { LiveStateView, WorldStateView } from './types.js';

/**
 * Entry point to the game server. One instance per tab.
 *
 * The auth token is passed in, never stored here and never minted here: the
 * API issues it and the game server verifies it (SPECs §36).
 */

export const ROOM_CITY = 'city';
export const ROOM_APARTMENT = 'apartment';
export const ROOM_LIVE = 'live';

function defaultEndpoint(): string {
  const configured = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  if (configured) return configured;
  // Dev default: the game server next to the Vite dev server. In production
  // this must be set — a wss:// page cannot open a ws:// socket.
  const secure = location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${location.hostname}:2567`;
}

export interface SessionOptions {
  /**
   * Session token minted by the API. It carries the identity AND the validated
   * appearance — the client no longer sends either, because the server has no
   * way to tell a real claim from a forged one when the browser is the source.
   */
  token: string;
}

/** What a host may choose about their own broadcast. Not who they are. */
export interface GoLiveOptions {
  title: string;
  category: string;
  sceneId?: SceneId;
}

export class NetworkClient {
  private readonly client: Client;

  constructor(private session: SessionOptions, endpoint = defaultEndpoint()) {
    this.client = new Client(endpoint);
    this.httpBase = endpoint.replace(/^ws/, 'http');
  }

  private readonly httpBase: string;

  setToken(token: string): void {
    this.session = { ...this.session, token };
  }

  /** Joins (or shards into) a public area. */
  async joinCity(sceneId: SceneId = 'central_plaza'): Promise<WorldConnection> {
    const room = await this.client.joinOrCreate<WorldStateView>(ROOM_CITY, {
      ...this.joinOptions(),
      sceneId,
    });
    return new WorldConnection(room);
  }

  /**
   * Enters an apartment by id. Owner, furniture and privacy are resolved by the
   * server against the API — the browser only names the door.
   */
  async joinApartment(apartmentId: string): Promise<WorldConnection> {
    const room = await this.client.joinOrCreate<WorldStateView>(ROOM_APARTMENT, {
      ...this.joinOptions(),
      apartmentId,
    });
    return new WorldConnection(room);
  }

  /**
   * Opens a broadcast. `create`, never `joinOrCreate`: the host is read from
   * the token inside onCreate, so this can only ever open the caller's own live.
   */
  async goLive(options: GoLiveOptions): Promise<WorldConnection<LiveStateView>> {
    const room = await this.client.create<LiveStateView>(ROOM_LIVE, {
      ...this.joinOptions(),
      ...options,
    });
    return new WorldConnection(room);
  }

  /**
   * Enters someone else's live as audience, by the room id the feed listed.
   * Joining by id cannot create anything, which is what stops a client from
   * "joining" a live that does not exist and becoming its host.
   *
   * The stage is never requested here: the host invites, and the guest accepts
   * with `connection.acceptStage()`.
   */
  async watchLive(roomId: string): Promise<WorldConnection<LiveStateView>> {
    const room = await this.client.joinById<LiveStateView>(roomId, this.joinOptions());
    return new WorldConnection(room);
  }

  /**
   * Live feed source. Reads the game server's listing while the API's /lives
   * does not exist yet; swapping it later is a one-line change here.
   * TODO(api agent): point this at GET /lives once it ships.
   */
  async listLives(): Promise<LiveSummary[]> {
    const res = await fetch(`${this.httpBase}/live`);
    if (!res.ok) throw new Error(`listagem de lives falhou (${res.status})`);
    return (await res.json()) as LiveSummary[];
  }

  /**
   * Everything the browser is allowed to say about itself: the token. Identity
   * and appearance are read from it server-side (SPECs §36, §68 regra 6).
   */
  private joinOptions(): Record<string, unknown> {
    return { token: this.session.token };
  }
}
