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

/** O que GET /lives devolve. Espelha packages/api/src/world/Lives.ts. */
interface ApiLiveListing {
  liveId: string;
  externalId: string | null;
  roomId: string | null;
  hostId: string;
  hostName: string;
  title: string;
  category: string;
  likes: number;
  startedAt: string;
}

/**
 * Espera o primeiro patch antes de devolver a conexão.
 *
 * Sem isso quem recebe a sala lê o estado no seu valor DEFAULT — e quem
 * pergunta "em que cena estou?" nesse instante ouve "praça central" dentro de
 * uma live. O timeout existe para uma sala que, por algum motivo, não emita
 * patch nenhum: melhor entrar com o default do que não entrar.
 */
async function synced<S extends WorldStateView>(
  connection: WorldConnection<S>, timeoutMs = 4_000,
): Promise<WorldConnection<S>> {
  await Promise.race([
    connection.ready,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return connection;
}

export const ROOM_CITY = 'city';
export const ROOM_APARTMENT = 'apartment';
export const ROOM_LIVE = 'live';

function defaultApiBase(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return `${location.protocol}//${location.hostname}:8787`;
}

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
  /** HTTP do game server: só tempo real (contagem de espectadores agora). */
  private readonly httpBase: string;
  /** HTTP da API: a camada persistente — quem está no ar, de quem é a casa. */
  private readonly apiBase: string;

  constructor(
    private session: SessionOptions,
    endpoint = defaultEndpoint(),
    apiBase = defaultApiBase(),
  ) {
    this.client = new Client(endpoint);
    this.httpBase = endpoint.replace(/^ws/, 'http');
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  setToken(token: string): void {
    this.session = { ...this.session, token };
  }

  /** Joins (or shards into) a public area. */
  async joinCity(sceneId: SceneId = 'central_plaza'): Promise<WorldConnection> {
    const room = await this.client.joinOrCreate<WorldStateView>(ROOM_CITY, {
      ...this.joinOptions(),
      sceneId,
    });
    return synced(new WorldConnection(room));
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
    return synced(new WorldConnection(room));
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
    return synced(new WorldConnection(room));
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
    return synced(new WorldConnection(room));
  }

  /**
   * Feed de lives.
   *
   * A LISTA vem da API: quem está no ar é estado persistente e social, e é a
   * API que sabe responder isso mesmo com o game server reiniciando. O que a
   * API não tem é a contagem de espectadores AGORA — isso é tempo real e mora
   * no game server —, então o número é enxertado a partir do listing dele
   * quando ele responde. Se não responder, a lista continua correta e o
   * contador aparece zerado: melhor um número faltando que uma live faltando.
   */
  async listLives(): Promise<LiveSummary[]> {
    const lives = await this.listFromApi();
    const live = new Map(
      (await this.listRealtime()).map((room) => [room.roomId, room] as const),
    );
    return lives
      .map((summary) => {
        const now = live.get(summary.roomId);
        return now ? { ...summary, realViewers: now.realViewers, isPK: now.isPK } : summary;
      })
      .sort((a, b) => b.realViewers - a.realViewers || b.startedAt - a.startedAt);
  }

  private async listFromApi(): Promise<LiveSummary[]> {
    const res = await fetch(`${this.apiBase}/lives`);
    if (!res.ok) throw new Error(`listagem de lives falhou (${res.status})`);
    const body = (await res.json()) as { lives?: ApiLiveListing[] };
    return (body.lives ?? [])
      // Sem roomId ninguém consegue entrar: uma linha assim é sessão órfã de
      // um game server que caiu, não uma live assistível.
      .filter((row) => typeof row.roomId === 'string' && row.roomId.length > 0)
      .map((row) => ({
        roomId: row.roomId as string,
        liveId: row.externalId ?? row.liveId,
        hostId: row.hostId,
        hostName: row.hostName,
        title: row.title,
        category: row.category,
        realViewers: 0,
        isPK: false,
        agency: '',
        startedAt: new Date(row.startedAt).getTime(),
      }));
  }

  /** Contagens do game server. Best-effort: um erro aqui não some com o feed. */
  private async listRealtime(): Promise<LiveSummary[]> {
    try {
      const res = await fetch(`${this.httpBase}/live`);
      if (!res.ok) return [];
      return (await res.json()) as LiveSummary[];
    } catch {
      return [];
    }
  }

  /** Qual apartamento é o do jogador (a API é dona dessa resposta). */
  async myHome(): Promise<string | null> {
    try {
      const res = await fetch(`${this.apiBase}/me/home`, {
        headers: { authorization: `Bearer ${this.session.token}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { home?: { apartmentId?: string } };
      return body.home?.apartmentId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Everything the browser is allowed to say about itself: the token. Identity
   * and appearance are read from it server-side (SPECs §36, §68 regra 6).
   */
  private joinOptions(): Record<string, unknown> {
    return { token: this.session.token };
  }
}
