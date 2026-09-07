import { config } from '../config.js';
import type { HomePlacement, PKResult, PresenceSnapshot } from '../shared.js';

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
  /**
   * Móveis colocados, COM posição. Já era isto que `/internal/homes/:id`
   * respondia; era este tipo que dizia `string[]` e fazia a sala tratar cada
   * objeto como se fosse um id — nenhum casava com o catálogo, e a decoração
   * chegava vazia do lado do servidor.
   */
  decor: HomePlacement[];
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

/**
 * Ordem de moderação vinda do painel (PRD §28).
 *
 * Ela chega de CARONA na resposta do batimento de presença, e não por uma porta
 * nova neste processo: um endpoint que encerra transmissão é superfície que a
 * gente prefere não expor, e o batimento já acontece de qualquer jeito.
 */
export interface ModerationCommand {
  id: string;
  command: 'close_live';
  targetType: 'room';
  targetId: string;
  reason: string;
}

export interface ApiGateway {
  getHome(apartmentId: string): Promise<HomeSnapshot | null>;
  canEnterHome(apartmentId: string, userId: string): Promise<boolean>;
  openLive(input: OpenLiveInput): Promise<{ liveId: string } | null>;
  closeLive(input: CloseLiveInput): Promise<void>;
  recordPKResult(input: PKResultInput): Promise<void>;
  /**
   * Retrato de quem está em sala neste processo (SPECs §17). A resposta traz o
   * que o painel mandou fazer — ver `ModerationCommand`.
   */
  publishPresence(snapshot: PresenceSnapshot): Promise<ModerationCommand[]>;
  /** Confirma o que aconteceu com uma ordem. */
  ackModeration(commandId: string, result: string): Promise<void>;
  /** Interações sociais que só este processo vê (§32): chat, live, PK, visita. */
  reportSocial(entries: Array<{ userId: string; kind: string }>): Promise<void>;
}

/**
 * As flags que o último batimento trouxe (SPECs §64).
 *
 * O game server não fala com o banco, e abrir uma rota só para consultar flag
 * seria uma segunda porta para manter — elas vêm no mesmo canal das ordens de
 * moderação. Enquanto nenhum batimento tiver chegado, o valor é o `fallback` de
 * quem pergunta: um processo que acabou de subir não pode desligar o jogo por
 * não saber a resposta ainda.
 */
const flagsRecebidas = new Map<string, boolean>();

export function setFlags(valores: Record<string, boolean>): void {
  for (const [k, v] of Object.entries(valores)) flagsRecebidas.set(k, v);
}

export function flagEnabled(key: string, fallback: boolean): boolean {
  return flagsRecebidas.get(key) ?? fallback;
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

  async publishPresence(snapshot: PresenceSnapshot): Promise<ModerationCommand[]> {
    const resposta = await this.call<{ commands?: ModerationCommand[]; flags?: Record<string, boolean> }>(
      '/internal/presence', { method: 'POST', body: JSON.stringify(snapshot) },
    );
    // §64: as flags chegam de carona no batimento. Guardar aqui é o que permite
    // a sala perguntar sem ir à rede no meio de uma ação do jogador.
    if (resposta?.flags) setFlags(resposta.flags);
    return resposta?.commands ?? [];
  }

  async ackModeration(commandId: string, result: string): Promise<void> {
    await this.call('/internal/moderation/ack', {
      method: 'POST', body: JSON.stringify({ commandId, result }),
    });
  }

  async reportSocial(entries: Array<{ userId: string; kind: string }>): Promise<void> {
    const resposta = await this.call('/internal/social', {
      method: 'POST', body: JSON.stringify({ entries }),
    });
    // `call` devolve null em qualquer não-2xx; sem isto, um lote recusado seria
    // dado como entregue e sumiria da métrica.
    if (resposta === null) throw new Error('relato social recusado pela API');
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

  async publishPresence(snapshot: PresenceSnapshot): Promise<ModerationCommand[]> {
    this.lastPresence = snapshot;
    return [];
  }

  async ackModeration(): Promise<void> { /* sem API, sem painel */ }

  async reportSocial(): Promise<void> { /* sem API, sem métrica */ }
}

export function defaultApiGateway(): ApiGateway {
  if (config.apiBaseUrl) return new HttpApiGateway(config.apiBaseUrl, config.apiServiceToken);
  if (config.env === 'production') {
    throw new Error('API_BASE_URL is required in production — refusing to resolve homes in memory');
  }
  console.warn('[api] API_BASE_URL vazio — usando InMemoryApiGateway (somente desenvolvimento).');
  return new InMemoryApiGateway();
}
