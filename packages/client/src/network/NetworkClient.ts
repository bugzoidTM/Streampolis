import { Client } from 'colyseus.js';
import type { AvatarConfig, LiveSummary, SceneId } from '@streampolis/shared';
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
  token: string;
  avatar?: AvatarConfig;
}

export interface GoLiveOptions {
  liveId: string;
  hostId: string;
  hostName: string;
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

  async joinApartment(ownerId: string, ownerName = ''): Promise<WorldConnection> {
    const room = await this.client.joinOrCreate<WorldStateView>(ROOM_APARTMENT, {
      ...this.joinOptions(),
      ownerId,
      ownerName,
    });
    return new WorldConnection(room);
  }

  /** Opens a broadcast. The caller must be the host named in `options`. */
  async goLive(options: GoLiveOptions): Promise<WorldConnection<LiveStateView>> {
    const room = await this.client.joinOrCreate<LiveStateView>(ROOM_LIVE, {
      ...this.joinOptions(),
      ...options,
    });
    return new WorldConnection(room);
  }

  /** Enters someone else's live as audience, or as co-host when invited. */
  async watchLive(liveId: string, hostId: string, asCohost = false): Promise<WorldConnection<LiveStateView>> {
    const room = await this.client.joinOrCreate<LiveStateView>(ROOM_LIVE, {
      ...this.joinOptions(),
      liveId,
      hostId,
      ...(asCohost ? { role: 'cohost' } : {}),
    });
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

  private joinOptions(): Record<string, unknown> {
    return {
      token: this.session.token,
      ...(this.session.avatar ? { avatar: this.session.avatar } : {}),
    };
  }
}
