import type { AvatarConfig, Currency, LiveSummary } from '@streampolis/shared';

/**
 * Cliente HTTP da API.
 *
 * Fronteira única entre as telas e `packages/api`. Nenhum componente monta URL
 * nem manda `fetch`: o que a UI conhece são funções tipadas, e o que ela pode
 * dizer ao servidor é intenção — comprar ESTE item com ESTA moeda, seguir ESTA
 * pessoa. Preço, saldo e contagem voltam do servidor (SPECs §68 regra 6).
 */

export interface ApiIdentity {
  userId: string;
  displayName: string;
  permissions: string[];
  gifterLevel: number;
  agency: string;
  avatar: AvatarConfig;
}

export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string;
  bio: string;
  avatar: AvatarConfig;
  fame: number;
  level: number;
  creatorPoints: number;
  gifterXp: number;
  gifterLevel: number;
  followers: number;
  following: number;
  agency: string | null;
  presence: string;
  apartmentId: string | null;
  apartmentVisibility: 'open' | 'friends' | 'private';
  isLive: boolean;
  liveRoomId: string | null;
  liveTitle: string | null;
  isSelf: boolean;
  isFollowing: boolean;
}

export interface Wallet { credits: number; coins: number }

export interface DemoAccount {
  username: string;
  displayName: string;
  avatar: AvatarConfig | null;
}

export interface MeResponse {
  identity: ApiIdentity;
  wallet: Wallet;
  profile: PublicProfile | null;
  inventory: string[];
  following: string[];
}

export interface PurchaseResponse {
  itemId: string;
  currency: Currency;
  price: number;
  balances: Wallet;
  replayed: boolean;
  alreadyOwned: boolean;
}

export interface ApiLive extends LiveSummary {
  /** Aparência do host, para o feed desenhar a capa de verdade. */
  hostAvatar: AvatarConfig | null;
  likes: number;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function defaultBase(): string {
  const configured = import.meta.env.VITE_API_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return `${location.protocol}//${location.hostname}:8787`;
}

export class ApiClient {
  constructor(private token: string | undefined, private readonly base = defaultBase()) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      // A API responde `{error, message}`; a mensagem é escrita para o jogador
      // ler, então ela sobe até a tela em vez de virar "erro 402".
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ApiError(res.status, body.error ?? 'erro', body.message ?? mensagemPara(res.status));
    }
    return (await res.json()) as T;
  }

  me(): Promise<MeResponse> {
    return this.call<MeResponse>('/me');
  }

  /** Contas jogáveis da demonstração. Vazio quando a API não as oferece. */
  async demoAccounts(): Promise<DemoAccount[]> {
    try {
      const body = await this.call<{ accounts: DemoAccount[] }>('/auth/demo-accounts');
      return body.accounts ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Entrada da demonstração: username sem senha. A API só responde isto fora
   * de produção — é uma porta aberta de propósito, e por isso ela não existe
   * onde houver dinheiro de verdade.
   */
  async enterAs(username: string): Promise<{ token: string; identity: ApiIdentity }> {
    return this.call('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }

  /**
   * Feed de lives.
   *
   * A LISTA é da API: quem está no ar é estado persistente e social, e continua
   * certo com o game server reiniciando. A contagem de espectadores AGORA e o
   * "está em PK" são tempo real e só o game server sabe — por isso os dois são
   * enxertados a partir do listing dele, e a ausência dele custa dois números,
   * não a lista inteira.
   */
  async lives(): Promise<ApiLive[]> {
    const [body, realtime] = await Promise.all([
      this.call<{ lives: RawLive[] }>('/lives'),
      realtimeLives(),
    ]);
    const now = new Map(realtime.map((r) => [r.roomId, r] as const));
    return body.lives
      .filter((row) => Boolean(row.roomId))
      .map((row) => {
        const live = now.get(row.roomId as string);
        return {
          roomId: row.roomId as string,
          liveId: row.externalId ?? row.liveId,
          hostId: row.hostId,
          hostName: row.hostName,
          hostAvatar: (row.hostAvatar as AvatarConfig | null) ?? null,
          title: row.title,
          category: row.category,
          likes: row.likes,
          realViewers: live?.realViewers ?? 0,
          isPK: live?.isPK ?? false,
          agency: live?.agency ?? '',
          startedAt: new Date(row.startedAt).getTime(),
        };
      })
      .sort((a, b) => b.realViewers - a.realViewers || b.startedAt - a.startedAt);
  }

  async profile(userId: string): Promise<PublicProfile> {
    return (await this.call<{ profile: PublicProfile }>(`/users/${encodeURIComponent(userId)}`)).profile;
  }

  follow(userId: string, following: boolean): Promise<{ following: boolean; followers: number }> {
    return this.call(`/users/${encodeURIComponent(userId)}/follow`, {
      method: 'PUT',
      body: JSON.stringify({ following }),
    });
  }

  /**
   * Compra. A chave de idempotência é gerada aqui e DEVE ser reusada num
   * retry: é ela que faz um reenvio custar zero em vez de cobrar de novo.
   */
  purchase(itemId: string, currency: Currency, idempotencyKey = newKey()): Promise<PurchaseResponse> {
    return this.call<PurchaseResponse>('/me/purchases', {
      method: 'POST',
      body: JSON.stringify({ itemId, currency, idempotencyKey }),
    });
  }

  inventory(): Promise<{ items: string[] }> {
    return this.call('/me/inventory');
  }

  /** Salvar a aparência devolve um token novo: o antigo ainda veste a roupa velha. */
  saveAvatar(avatar: AvatarConfig): Promise<{ avatar: AvatarConfig; token: string; rejected: unknown[] }> {
    return this.call('/me/avatar', { method: 'PUT', body: JSON.stringify(avatar) });
  }
}

interface RawLive {
  liveId: string;
  externalId: string | null;
  roomId: string | null;
  hostId: string;
  hostName: string;
  hostAvatar: unknown;
  title: string;
  category: string;
  likes: number;
  startedAt: string;
}

/** Listagem em tempo real do game server. Best-effort por definição. */
async function realtimeLives(): Promise<LiveSummary[]> {
  const configured = import.meta.env.VITE_GAME_SERVER_URL as string | undefined;
  const base = (configured ?? `${location.protocol}//${location.hostname}:2567`)
    .replace(/^ws/, 'http')
    .replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/live`);
    if (!res.ok) return [];
    return (await res.json()) as LiveSummary[];
  } catch {
    return [];
  }
}

function mensagemPara(status: number): string {
  if (status === 401) return 'Sessão expirada. Entre de novo.';
  if (status === 402) return 'Saldo insuficiente.';
  if (status === 404) return 'Não encontrado.';
  if (status === 429) return 'Muitas tentativas. Espere um instante.';
  return 'Não foi possível concluir.';
}

export function newKey(): string {
  return `shop_${crypto.randomUUID()}`;
}
