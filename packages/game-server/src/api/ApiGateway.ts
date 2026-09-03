import { config } from '../config.js';
import type { PKResult, PresenceSnapshot } from '../shared.js';

/**
 * Boundary with packages/api for everything that is NOT money (that one has its
 * own gateway). Two kinds of call live here:
 *
 *   - things the room must not take from the browser: who owns an apartment,
 *     what is in it, who may enter;
 *   - things the room decided and the API has to remember: a live opening and
 *     closing, and the final score of a PK battle.
 *
 * The direction matters. The game server is the authority on the battle
 * (SPECs §33) and the API is its memory — this file never asks the API who won.
 */

export type HomeVisibility = 'open' | 'friends' | 'private';

export interface HomeSnapshot {
  apartmentId: string;
  ownerId: string;
  ownerName: string;
  layoutId: string;
  visibility: HomeVisibility;
  decor: string[];
}

export interface OpenLiveInput {
  externalId: string;
  hostId: string;
  title: string;
  category: string;
  roomId: string;
}

export interface CloseLiveInput {
  externalId: string;
  hostId: string;
  peakViewers: number;
  uniqueViewers: number;
  likes: number;
}

export interface PKResultInput extends PKResult {
  hostA: string;
  hostB: string;
  streamId?: string | null;
  startedAt?: number | null;
}

export interface ApiGateway {
  getHome(apartmentId: string): Promise<HomeSnapshot | null>;
  canEnterHome(apartmentId: string, userId: string): Promise<boolean>;
  openLive(input: OpenLiveInput): Promise<{ liveId: string } | null>;
  closeLive(input: CloseLiveInput): Promise<void>;
  recordPKResult(input: PKResultInput): Promise<void>;
  /** Retrato de quem está em sala neste processo (SPECs §17). */
  publishPresence(snapshot: PresenceSnapshot): Promise<void>;
}

export class HttpApiGateway implements ApiGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly timeoutMs = 4_000,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.serviceToken}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  getHome(apartmentId: string): Promise<HomeSnapshot | null> {
    return this.call<HomeSnapshot>(`/internal/homes/${encodeURIComponent(apartmentId)}`);
  }

  async canEnterHome(apartmentId: string, userId: string): Promise<boolean> {
    const res = await this.call<{ allowed: boolean }>(
      `/internal/homes/${encodeURIComponent(apartmentId)}/can-enter/${encodeURIComponent(userId)}`,
    );
    // Fail closed: an API outage locks doors instead of opening every home.
    return res?.allowed === true;
  }

  openLive(input: OpenLiveInput): Promise<{ liveId: string } | null> {
    return this.call<{ liveId: string }>('/internal/lives', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async closeLive(input: CloseLiveInput): Promise<void> {
    await this.call('/internal/lives/close', { method: 'POST', body: JSON.stringify(input) });
  }

  async publishPresence(snapshot: PresenceSnapshot): Promise<void> {
    await this.call('/internal/presence', { method: 'POST', body: JSON.stringify(snapshot) });
  }

  async recordPKResult(input: PKResultInput): Promise<void> {
    await this.call('/internal/pk/result', {
      method: 'POST',
      body: JSON.stringify({
        battleId: input.battleId,
        hostA: input.hostA,
        hostB: input.hostB,
        scoreA: input.scoreA,
        scoreB: input.scoreB,
        draw: input.draw,
        winnerId: input.winnerId,
        streamId: input.streamId ?? null,
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt,
      }),
    });
  }
}

/**
 * Development double. Every apartment is the visitor's own and wide open —
 * good enough to walk around without an API, useless as a security model, which
 * is why defaultApiGateway() refuses it in production.
 */
export class InMemoryApiGateway implements ApiGateway {
  readonly lives = new Map<string, OpenLiveInput>();
  readonly pkResults: PKResultInput[] = [];
  /**
   * Último retrato de presença. Sem API não há diretório para consultar, mas
   * guardar o retrato deixa o e2e sem banco olhar o que o servidor DIRIA.
   */
  lastPresence: PresenceSnapshot | null = null;

  async getHome(apartmentId: string): Promise<HomeSnapshot> {
    return {
      apartmentId,
      ownerId: apartmentId,
      ownerName: `Cidadão ${apartmentId.slice(0, 8)}`,
      layoutId: 'studio_01',
      visibility: 'open',
      decor: [],
    };
  }

  async canEnterHome(): Promise<boolean> {
    return true;
  }

  async openLive(input: OpenLiveInput): Promise<{ liveId: string }> {
    this.lives.set(input.externalId, input);
    return { liveId: input.externalId };
  }

  async closeLive(input: CloseLiveInput): Promise<void> {
    this.lives.delete(input.externalId);
  }

  async recordPKResult(input: PKResultInput): Promise<void> {
    this.pkResults.push(input);
  }

  async publishPresence(snapshot: PresenceSnapshot): Promise<void> {
    this.lastPresence = snapshot;
  }
}

export function defaultApiGateway(): ApiGateway {
  if (config.apiBaseUrl) return new HttpApiGateway(config.apiBaseUrl, config.apiServiceToken);
  if (config.env === 'production') {
    throw new Error('API_BASE_URL is required in production — refusing to resolve homes in memory');
  }
  console.warn('[api] API_BASE_URL vazio — usando InMemoryApiGateway (somente desenvolvimento).');
  return new InMemoryApiGateway();
}
