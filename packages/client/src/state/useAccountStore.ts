import { create } from 'zustand';
import type { AvatarConfig, Currency } from '@streampolis/shared';
import { ApiClient, ApiError, type ApiLive, type PublicProfile, type Wallet } from '../network/api.js';
import { activeConnection } from './useSessionStore.js';

/**
 * A conta do jogador, como o servidor a conhece.
 *
 * Regra desta store: ela nunca CALCULA nada de valor. Comprar não subtrai do
 * saldo local — manda comprar e adota o saldo que voltou; seguir não soma um
 * seguidor — adota a contagem que voltou. É o mesmo princípio do gift: o
 * cliente pede, o servidor decide (SPECs §68 regra 6).
 */

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface AccountState {
  api: ApiClient | null;
  token: string | null;
  state: LoadState;
  error: string | null;

  userId: string | null;
  displayName: string;
  wallet: Wallet;
  profile: PublicProfile | null;
  avatar: AvatarConfig | null;
  owned: Set<string>;
  /** Quem eu sigo; alimenta a aba "Seguindo" do feed. */
  following: Set<string>;

  /** Feed de lives; carregado sob demanda pela tela. */
  lives: ApiLive[];
  livesState: LoadState;

  connect: (token: string | undefined) => void;
  refresh: () => Promise<void>;
  loadLives: () => Promise<void>;
  buy: (itemId: string, currency: Currency) => Promise<{ ok: boolean; message: string }>;
  setFollow: (userId: string, following: boolean) => Promise<void>;
  wear: (avatar: AvatarConfig) => Promise<{ ok: boolean; message: string }>;
}

const EMPTY_WALLET: Wallet = { credits: 0, coins: 0 };

export const useAccountStore = create<AccountState>((set, get) => ({
  api: null,
  token: null,
  state: 'idle',
  error: null,

  userId: null,
  displayName: '',
  wallet: EMPTY_WALLET,
  profile: null,
  avatar: null,
  owned: new Set(),
  following: new Set(),

  lives: [],
  livesState: 'idle',

  connect: (token) => {
    set({ api: new ApiClient(token), token: token ?? null });
    if (token) void get().refresh();
  },

  refresh: async () => {
    const api = get().api;
    if (!api?.authenticated) return;
    set({ state: 'loading', error: null });
    try {
      const me = await api.me();
      set({
        state: 'ready',
        userId: me.identity.userId,
        displayName: me.identity.displayName,
        wallet: me.wallet,
        profile: me.profile,
        avatar: me.identity.avatar,
        owned: new Set(me.inventory),
        following: new Set(me.following ?? []),
      });
    } catch (err) {
      set({ state: 'error', error: mensagem(err) });
    }
  },

  loadLives: async () => {
    const api = get().api ?? new ApiClient(undefined);
    set({ livesState: 'loading' });
    try {
      set({ lives: await api.lives(), livesState: 'ready' });
    } catch (err) {
      // Feed vazio com erro visível é melhor do que feed com dado inventado.
      set({ lives: [], livesState: 'error', error: mensagem(err) });
    }
  },

  buy: async (itemId, currency) => {
    const api = get().api;
    if (!api?.authenticated) return { ok: false, message: 'Entre para comprar.' };
    try {
      const result = await api.purchase(itemId, currency);
      const owned = new Set(get().owned);
      owned.add(result.itemId);
      // Saldo do servidor, não subtração local.
      set({ wallet: result.balances, owned });
      return {
        ok: true,
        message: result.alreadyOwned ? 'Você já tinha este item.' : 'Comprado!',
      };
    } catch (err) {
      return { ok: false, message: mensagem(err) };
    }
  },

  setFollow: async (userId, following) => {
    const api = get().api;
    if (!api?.authenticated) return;
    try {
      const result = await api.follow(userId, following);
      const next = new Set(get().following);
      if (result.following) next.add(userId); else next.delete(userId);
      set({ following: next });
      const profile = get().profile;
      if (profile && profile.userId === userId) {
        set({ profile: { ...profile, isFollowing: result.following, followers: result.followers } });
      }
    } catch {
      // Falhar em seguir não estraga a tela; o estado continua o do servidor.
    }
  },

  wear: async (avatar) => {
    const api = get().api;
    if (!api?.authenticated) return { ok: false, message: 'Entre para trocar de roupa.' };
    try {
      const result = await api.saveAvatar(avatar);
      // Token novo junto: o antigo ainda carrega a aparência anterior assinada,
      // e é ele que entra nas salas.
      api.setToken(result.token);
      set({ avatar: result.avatar, token: result.token });
      // E a sala repinta na hora. Sem isto o visual só aparecia para os outros
      // depois de reconectar — o jogador salvava a roupa e o mundo continuava
      // com a antiga, que lê como "não salvou".
      activeConnection()?.restyle(result.token);
      return { ok: true, message: 'Look salvo.' };
    } catch (err) {
      return { ok: false, message: mensagem(err) };
    }
  },
}));

function mensagem(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Não foi possível falar com o servidor.';
}
