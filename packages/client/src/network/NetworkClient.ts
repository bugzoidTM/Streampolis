import { Client } from 'colyseus.js';
import type { SceneId } from '@streampolis/shared';
import { WorldConnection } from './WorldConnection.js';
import type { LiveStateView, WorldStateView } from './types.js';

/**
 * Entry point to the game server. One instance per tab.
 *
 * The auth token is passed in, never stored here and never minted here: the
 * API issues it and the game server verifies it (SPECs §36).
 */

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

/**
 * O servidor recusou o crachá. Mesma forma do `ServerError` do Colyseus
 * (`code` 401) para que quem trata a falha não precise saber se ela veio da
 * sala ou da API.
 */
export class SessionRejected extends Error {
  readonly code = 401;
  constructor() {
    super('expired');
    this.name = 'SessionRejected';
  }
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
   * Entra numa sala EXISTENTE pelo id do shard (SPECs §17).
   *
   * `joinById`, e não `joinOrCreate`: é a diferença entre encontrar alguém e
   * abrir uma sala vazia com o mesmo nome de cena. Como consequência, uma sala
   * cheia (o matchmaker a TRANCA quando lota, que é como o sharding acontece)
   * recusa o assento e joga — quem decide o que fazer com a recusa é
   * `session.ts`, não este método.
   *
   * Nada aqui confere amizade: o `roomId` é a credencial, e ele só sai da API
   * para amigos aceitos (`/friends/:id/location`). A sala continua conferindo o
   * que sempre confere — o token no `onAuth`, e a porta fechada do apartamento.
   */
  async joinShard(roomId: string): Promise<WorldConnection> {
    const room = await this.client.joinById<WorldStateView>(roomId, this.joinOptions());
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
    return synced(new WorldConnection(room, apartmentId));
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
   * Qual apartamento é o do jogador (a API é dona dessa resposta).
   *
   * O 401 é DESTACADO dos demais erros de propósito. Ele não quer dizer "você
   * não tem casa" — quer dizer "seu crachá venceu", e engolir os dois no mesmo
   * `null` era o que fazia a porta de casa devolver o jogador à praça em vez de
   * renovar a sessão.
   */
  async myHome(): Promise<string | null> {
    try {
      const res = await fetch(`${this.apiBase}/me/home`, {
        headers: { authorization: `Bearer ${this.session.token}` },
      });
      if (res.status === 401) throw new SessionRejected();
      if (!res.ok) return null;
      const body = (await res.json()) as { home?: { apartmentId?: string } };
      return body.home?.apartmentId ?? null;
    } catch (err) {
      if (err instanceof SessionRejected) throw err;
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
