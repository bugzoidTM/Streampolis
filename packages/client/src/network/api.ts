import type { HomePlacement, AvatarConfig, Currency, LiveSummary } from '@streampolis/shared';
import { authSession, type IssuedSession } from './authSession.js';

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
  friendship: FriendshipState;
  /** EU bloqueei esta pessoa. Nunca o contrário — a API não conta isso a ninguém. */
  isBlocked: boolean;
}

/**
 * Amizade, do ponto de vista de quem pergunta (PRD §20).
 *
 * A mesma linha do banco é `outgoing` para um lado e `incoming` para o outro:
 * quem manda no rótulo é quem está olhando, não a tabela.
 */
export type FriendshipState = 'none' | 'outgoing' | 'incoming' | 'friends';

/** Estado grosso de presença; `null` é offline (ausência de registro). */
export type PresenceKind = 'in_world' | 'watching_live' | 'streaming' | 'in_pk';

export interface Friend {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig;
  gifterLevel: number;
  agency: string | null;
  state: FriendshipState;
  since: string;
  presence: PresenceKind | null;
  online: boolean;
}

export interface FriendLists {
  friends: Friend[];
  incoming: Friend[];
  outgoing: Friend[];
}

/**
 * Onde o amigo está, com o SHARD. Só sai da API entre amigos aceitos — é o que
 * permite chegar até a pessoa, e não apenas até "a praça".
 */
export interface FriendLocation {
  userId: string;
  sceneId: string;
  roomId: string;
  kind: PresenceKind;
  since: number;
}

export type OnboardingStep =
  | 'create_avatar' | 'enter_plaza' | 'watch_live' | 'visit_apartment' | 'open_live';

export interface Onboarding {
  steps: Array<{ step: OnboardingStep; done: boolean; doneAt: string | null }>;
  next: OnboardingStep | null;
  completed: number;
  total: number;
  done: boolean;
}

export type ReportType = 'chat' | 'profile' | 'live' | 'avatar' | 'other';

export interface BlockedUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: AvatarConfig;
  blockedAt: string;
}

export interface CoinPackage {
  id: string;
  name: string;
  coins: number;
  bonusCoins: number;
  /** `coins + bonusCoins`, somado pela API — a tela nunca soma dinheiro. */
  totalCoins: number;
  priceCents: number;
  currency: string;
}

export interface CheckoutIntent {
  paymentId: string;
  packageId: string;
  coins: number;
  priceCents: number;
  currency: string;
  status: string;
  checkoutUrl: string;
  provider: string;
  /** PRD §15: presentear não transfere dinheiro. Vem da API para a frase ser
   *  a mesma em todo lugar onde ela precisa aparecer. */
  disclosure: string;
}

export interface PaymentSummary {
  paymentId: string;
  packageId: string;
  coins: number;
  priceCents: number;
  currency: string;
  status: string;
  createdAt: string;
  paidAt: string | null;
}

export interface Mission {
  id: string;
  title: string;
  hint: string;
  credits: number;
  xp: number;
  done: boolean;
  claimed: boolean;
  claimedAt: string | null;
}

export interface MissionsView {
  missions: Mission[];
  /** Cumpridas e ainda não resgatadas — o número do selo no botão. */
  claimable: number;
  completed: number;
  total: number;
}

export interface MissionClaim {
  missionId: string;
  credits: number;
  xp: number;
  balances: Wallet;
  replayed: boolean;
}

export interface NeedView {
  id: 'energia' | 'social' | 'humor' | 'conforto';
  label: string;
  value: number;
  /** O que fazer a respeito — é para isto que elas existem (§9). */
  hint: string;
}

export interface NeedsView {
  needs: Record<string, number>;
  views: NeedView[];
}

export interface DailyTask {
  id: string;
  title: string;
  hint: string;
  credits: number;
  done: boolean;
  claimed: boolean;
}

export interface DailyTasksView {
  day: string;
  tasks: DailyTask[];
  claimable: number;
  creditsAvailable: number;
  /** Quando a lista vira. Vem pronto da API — a tela não calcula fuso. */
  resetsAt: string;
}

export interface DailyClaim {
  taskId: string;
  day: string;
  credits: number;
  balances: Wallet;
  replayed: boolean;
}

/** Uma parada de bico, com o endereço que a tela desenha no mundo. */
export interface GigStop {
  id: string;
  hint: string;
  x: number;
  z: number;
  label: string;
  done: boolean;
}

export interface GigRun {
  runId: string;
  gigId: string;
  title: string;
  heat: number;
  credits: number;
  deadlineAt: string;
  startedAt: string;
  stopsDone: number;
  stops: GigStop[];
  next: GigStop | null;
}

export interface GigOffer {
  id: string;
  title: string;
  flavor: string;
  stops: number;
  /** Já corrigido pelo nível de atenção: é o que vai ser pago. */
  credits: number;
  seconds: number;
}

export interface GigBoard {
  heat: number;
  heatMax: number;
  runsInWindow: number;
  toNextLevel: number | null;
  windowHours: number;
  offers: GigOffer[];
  active: GigRun | null;
}

export type AgencyRole = 'owner' | 'manager' | 'member';

export interface AgencyMember {
  userId: string;
  username: string;
  displayName: string;
  role: AgencyRole;
  creatorPoints: number;
  joinedAt: string;
}

export interface Agency {
  agencyId: string;
  name: string;
  level: number;
  /** Soma dos Creator Points de quem está na agência agora — a API soma. */
  fame: number;
  ownerId: string;
  memberCount: number;
  createdAt: string;
  members?: AgencyMember[];
}

export interface AgencyInvite {
  agencyId: string;
  name: string;
  invitedBy: string;
  createdAt: string;
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

export interface ApiHome {
  apartmentId: string;
  ownerId: string;
  ownerName: string;
  layoutId: string;
  visibility: 'open' | 'friends' | 'private';
  decor: HomePlacement[];
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

export type RankingBoard = 'streamers' | 'gifters' | 'pk';
export type RankingRange = 'today' | 'week' | 'season';

export interface RankingEntry {
  userId: string;
  rank: number;
  username: string;
  displayName: string;
  avatar: AvatarConfig;
  value: number;
  fame: number;
  agency: string | null;
}

export interface RankingPage {
  board: RankingBoard;
  range: RankingRange;
  /** Nome da unidade do número, escrito pelo servidor. */
  unit: string;
  season: { name: string; endsAt: string } | null;
  since: string | null;
  entries: RankingEntry[];
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

  private async call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    // 401 com sessão no navegador é quase sempre o token de 15 minutos que
    // venceu — não "você não tem permissão". Renova UMA vez e repete; só se a
    // renovação também falhar é que isto vira erro para o jogador ver.
    if (res.status === 401 && !retried && this.token && !path.startsWith('/auth/')) {
      const fresh = await authSession.assegurar();
      if (fresh && fresh !== this.token) {
        this.token = fresh;
        return this.call<T>(path, init, true);
      }
    }
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

  // --------------------------------------------------------------- coins ---

  /**
   * Vitrine de Coins (PRD §15). Pública: preço não é segredo, e a tela precisa
   * dele antes de a pessoa decidir entrar na conta.
   */
  coinPackages(): Promise<{ packages: CoinPackage[]; disclosure: string }> {
    return this.call('/shop/coin-packages');
  }

  /**
   * Abre a intenção de compra. NÃO credita nada: a moeda entra quando o
   * provedor confirma o pagamento, e é por isso que a tela seguinte é do
   * provedor, não nossa.
   */
  startCheckout(packageId: string): Promise<CheckoutIntent> {
    return this.call('/me/checkout', { method: 'POST', body: JSON.stringify({ packageId }) });
  }

  /** Só existe com o provedor de mentira; em produção a rota nem responde. */
  confirmSandboxPayment(paymentId: string): Promise<{ result: string }> {
    return this.call(`/payments/sandbox/${encodeURIComponent(paymentId)}/confirm`, { method: 'POST' });
  }

  payments(): Promise<{ payments: PaymentSummary[] }> {
    return this.call('/me/payments');
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
  async enterAs(username: string): Promise<IssuedSession & { identity: ApiIdentity }> {
    return this.call('/auth/dev-login', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  }

  /**
   * Cria a conta e já entra: a resposta é o mesmo par de tokens do login.
   *
   * Existe porque `enterAs` (dev-login) é uma porta que só se abre fora de
   * produção — enquanto ela fosse a única, o jogo não podia valer dinheiro.
   */
  register(username: string, email: string, password: string): Promise<IssuedSession & { identity: ApiIdentity }> {
    return this.call('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    });
  }

  /** Entrar com a conta de verdade. */
  login(username: string, password: string): Promise<IssuedSession & { identity: ApiIdentity }> {
    return this.call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }

  // --------------------------------------------------------------- missões ---

  /**
   * Missões (PRD §24). O servidor deriva o cumprido dos fatos; a tela só
   * desenha e pede o resgate.
   */
  missions(): Promise<MissionsView> {
    return this.call('/me/missions');
  }

  claimMission(missionId: string): Promise<MissionClaim> {
    return this.call(`/me/missions/${encodeURIComponent(missionId)}/claim`, { method: 'POST' });
  }

  /** Necessidades do personagem (PRD §9). Não travam nada — orientam. */
  needs(): Promise<NeedsView> {
    return this.call('/me/needs');
  }

  /** Tarefas do dia (PRD §26). Viram à meia-noite do fuso do jogador. */
  dailyTasks(): Promise<DailyTasksView> {
    return this.call('/me/daily');
  }

  claimDailyTask(taskId: string): Promise<DailyClaim> {
    return this.call(`/me/daily/${encodeURIComponent(taskId)}/claim`, { method: 'POST' });
  }

  /**
   * Bicos de rua (PRD §26). Não existe "cheguei" aqui de propósito: quem vê a
   * chegada é o game server, que tem a posição — a tela só aceita e larga.
   */
  gigs(): Promise<GigBoard> {
    return this.call('/me/gigs');
  }

  acceptGig(gigId: string): Promise<{ run: GigRun }> {
    return this.call('/me/gigs', { method: 'POST', body: JSON.stringify({ gigId }) });
  }

  abandonGig(): Promise<{ abandoned: boolean }> {
    return this.call('/me/gigs', { method: 'DELETE' });
  }

  // -------------------------------------------------------------- agências ---

  /**
   * Agências (PRD §19). O nome da agência já aparecia no perfil e ao lado do
   * avatar na cidade — o que não existia era como entrar em uma.
   */
  myAgency(): Promise<{ agency: Agency | null; role: AgencyRole | null; invites: AgencyInvite[] }> {
    return this.call('/me/agency');
  }

  agencies(): Promise<{ agencies: Agency[] }> {
    return this.call('/agencies');
  }

  agency(agencyId: string): Promise<{ agency: Agency }> {
    return this.call(`/agencies/${encodeURIComponent(agencyId)}`);
  }

  createAgency(name: string): Promise<{ agency: Agency }> {
    return this.call('/agencies', { method: 'POST', body: JSON.stringify({ name }) });
  }

  inviteToAgency(agencyId: string, userId: string): Promise<{ invited: boolean }> {
    return this.call(
      `/agencies/${encodeURIComponent(agencyId)}/invites/${encodeURIComponent(userId)}`,
      { method: 'POST' },
    );
  }

  acceptAgencyInvite(agencyId: string): Promise<{ agency: Agency }> {
    return this.call(`/me/agency/invites/${encodeURIComponent(agencyId)}/accept`, { method: 'POST' });
  }

  declineAgencyInvite(agencyId: string): Promise<{ declined: boolean }> {
    return this.call(`/me/agency/invites/${encodeURIComponent(agencyId)}/decline`, { method: 'POST' });
  }

  leaveAgency(agencyId: string, userId: string): Promise<{ removed: boolean }> {
    return this.call(
      `/agencies/${encodeURIComponent(agencyId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  }

  setAgencyRole(agencyId: string, userId: string, role: 'manager' | 'member'): Promise<{ agency: Agency }> {
    return this.call(
      `/agencies/${encodeURIComponent(agencyId)}/members/${encodeURIComponent(userId)}/role`,
      { method: 'PUT', body: JSON.stringify({ role }) },
    );
  }

  disbandAgency(agencyId: string): Promise<{ disbanded: boolean }> {
    return this.call(`/agencies/${encodeURIComponent(agencyId)}`, { method: 'DELETE' });
  }

  // --------------------------------------------------------------- amigos ---

  friends(): Promise<FriendLists> {
    return this.call<FriendLists>('/me/friends');
  }

  /** Manda o convite. Convite cruzado já volta como `friends` — ver a API. */
  requestFriend(userId: string): Promise<{ userId: string; state: FriendshipState }> {
    return this.call(`/friends/${encodeURIComponent(userId)}`, { method: 'POST' });
  }

  acceptFriend(userId: string): Promise<{ userId: string; state: FriendshipState }> {
    return this.call(`/friends/${encodeURIComponent(userId)}/accept`, { method: 'POST' });
  }

  declineFriend(userId: string): Promise<{ userId: string; state: FriendshipState }> {
    return this.call(`/friends/${encodeURIComponent(userId)}/decline`, { method: 'POST' });
  }

  /** Desfaz a amizade ou cancela o convite que eu mandei. */
  removeFriend(userId: string): Promise<{ userId: string; state: FriendshipState }> {
    return this.call(`/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  /**
   * Onde o amigo está AGORA. `presence: null` é amigo offline, não erro — e um
   * 403 aqui quer dizer "vocês não são amigos", que é outra frase na tela.
   */
  friendLocation(userId: string): Promise<{ presence: FriendLocation | null }> {
    return this.call(`/friends/${encodeURIComponent(userId)}/location`);
  }

  // ------------------------------------------------------------ moderação ---

  block(userId: string, blocked: boolean): Promise<{ blocked: boolean }> {
    return this.call(`/users/${encodeURIComponent(userId)}/block`, {
      method: 'PUT',
      body: JSON.stringify({ blocked }),
    });
  }

  blocks(): Promise<{ blocked: BlockedUser[] }> {
    return this.call('/me/blocks');
  }

  /**
   * Denuncia. `contextId` é o que a moderação usa para ACHAR o caso depois — a
   * sala do chat, a live —, e sem ele sobra a palavra de um contra a do outro.
   */
  report(userId: string, type: ReportType, reason: string, contextId?: string): Promise<{
    reportId: string; status: string; duplicate: boolean;
  }> {
    return this.call(`/users/${encodeURIComponent(userId)}/report`, {
      method: 'POST',
      body: JSON.stringify({ type, reason, contextId }),
    });
  }

  /** A volta guiada da conta nova. Só leitura: quem marca passo é o servidor. */
  onboarding(): Promise<Onboarding> {
    return this.call<Onboarding>('/me/onboarding');
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

  /**
   * Placar (PRD §23). Não exige sessão: um ranking é vitrine.
   *
   * Nem a ordem nem a unidade são decididas aqui — a tela desenha as linhas na
   * ordem em que vieram e escreve a unidade que o servidor mandou. Ordenar no
   * cliente seria um segundo lugar onde "quem está ganhando" é calculado.
   */
  rankings(board: RankingBoard, range: RankingRange): Promise<RankingPage> {
    return this.call<RankingPage>(`/rankings?board=${board}&range=${range}`);
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

  home(): Promise<{ home: ApiHome }> {
    return this.call('/me/home');
  }

  /** A casa de outra pessoa. 403 quando ela não está aberta para você. */
  homeOf(apartmentId: string): Promise<{ home: ApiHome }> {
    return this.call(`/homes/${encodeURIComponent(apartmentId)}`);
  }

  /**
   * Manda a planta INTEIRA. A API confere posse, limites e sobreposição e
   * devolve a casa como ficou — quem decide onde o sofá cabe é ela.
   */
  saveHomeLayout(placements: readonly HomePlacement[]): Promise<{ home: ApiHome }> {
    return this.call('/me/home/layout', {
      method: 'PUT',
      body: JSON.stringify({ placements }),
    });
  }

  /** Salvar a aparência devolve um token novo: o antigo ainda veste a roupa velha. */
  saveAvatar(avatar: AvatarConfig): Promise<{
    avatar: AvatarConfig; token: string; expiresIn: number; rejected: unknown[];
  }> {
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
