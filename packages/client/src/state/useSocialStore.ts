import { create } from 'zustand';
import { ApiError, type Friend, type FriendLocation, type Onboarding } from '../network/api.js';
import { useAccountStore } from './useAccountStore.js';

/**
 * Amizade, moderação e a volta guiada da conta nova.
 *
 * Mesma regra da `useAccountStore`: esta store não CALCULA nada. Aceitar um
 * convite não move a pessoa da lista de convites para a de amigos por conta
 * própria — manda aceitar e relê as listas. Parece desperdício de uma chamada e
 * é o contrário: a lista tem três estados que dependem de quem pediu, e a
 * versão local delas seria um segundo lugar onde "somos amigos?" é decidido.
 *
 * A presença dos amigos é a única coisa aqui que envelhece sozinha — alguém
 * entra na praça sem que nada nesta aba aconteça. Por isso a lista tem
 * recarga por tempo, e ela só corre com o painel ABERTO: um cliente que
 * pergunta "quem está online?" a cada dez segundos com a aba fechada é tráfego
 * que ninguém vai ler.
 */

export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

interface SocialState {
  friends: Friend[];
  incoming: Friend[];
  outgoing: Friend[];
  state: LoadState;
  error: string | null;
  /** Ação em voo, por userId: o botão da linha vira "…" sem travar a lista toda. */
  busy: string | null;

  onboarding: Onboarding | null;

  load: () => Promise<void>;
  loadOnboarding: () => Promise<void>;
  request: (userId: string) => Promise<{ ok: boolean; message: string }>;
  accept: (userId: string) => Promise<void>;
  decline: (userId: string) => Promise<void>;
  remove: (userId: string) => Promise<void>;
  setBlocked: (userId: string, blocked: boolean) => Promise<{ ok: boolean; message: string }>;
  /** Onde o amigo está. `null` = offline; lança quando não há amizade. */
  locate: (userId: string) => Promise<FriendLocation | null>;
  clear: () => void;
}

export const useSocialStore = create<SocialState>((set, get) => ({
  friends: [],
  incoming: [],
  outgoing: [],
  state: 'idle',
  error: null,
  busy: null,
  onboarding: null,

  load: async () => {
    const api = useAccountStore.getState().api;
    if (!api?.authenticated) return;
    // Sem 'loading' quando já há lista: a recarga periódica não pode piscar a
    // tela inteira de dez em dez segundos.
    if (get().state !== 'ready') set({ state: 'loading', error: null });
    try {
      const lists = await api.friends();
      set({ ...lists, state: 'ready', error: null });
    } catch (err) {
      set({ state: 'error', error: mensagem(err) });
    }
  },

  loadOnboarding: async () => {
    const api = useAccountStore.getState().api;
    if (!api?.authenticated) return;
    try {
      set({ onboarding: await api.onboarding() });
    } catch {
      // A volta guiada é enfeite: falhar em lê-la não pode virar erro na tela.
    }
  },

  request: async (userId) => {
    const api = useAccountStore.getState().api;
    if (!api?.authenticated) return { ok: false, message: 'Entre para adicionar amigos.' };
    set({ busy: userId });
    try {
      const result = await api.requestFriend(userId);
      await get().load();
      return {
        ok: true,
        // Convite cruzado já nasce amizade — a API resolve isso, e a frase
        // precisa contar o que de fato aconteceu.
        message: result.state === 'friends' ? 'Vocês agora são amigos!' : 'Convite enviado.',
      };
    } catch (err) {
      return { ok: false, message: mensagem(err) };
    } finally {
      set({ busy: null });
    }
  },

  accept: async (userId) => { await mutate(set, get, userId, (api) => api.acceptFriend(userId)); },
  decline: async (userId) => { await mutate(set, get, userId, (api) => api.declineFriend(userId)); },
  remove: async (userId) => { await mutate(set, get, userId, (api) => api.removeFriend(userId)); },

  setBlocked: async (userId, blocked) => {
    const api = useAccountStore.getState().api;
    if (!api?.authenticated) return { ok: false, message: 'Entre para fazer isso.' };
    set({ busy: userId });
    try {
      await api.block(userId, blocked);
      // Bloquear derruba a amizade no servidor; a lista tem de refletir isso.
      await get().load();
      return {
        ok: true,
        message: blocked ? 'Pessoa bloqueada.' : 'Bloqueio removido.',
      };
    } catch (err) {
      return { ok: false, message: mensagem(err) };
    } finally {
      set({ busy: null });
    }
  },

  locate: async (userId) => {
    const api = useAccountStore.getState().api;
    if (!api?.authenticated) return null;
    return (await api.friendLocation(userId)).presence;
  },

  clear: () => set({
    friends: [], incoming: [], outgoing: [], state: 'idle', error: null, busy: null, onboarding: null,
  }),
}));

type Setter = (partial: Partial<SocialState>) => void;
type Getter = () => SocialState;

/** Aceitar, recusar e remover são a mesma coreografia: marca, chama, relê. */
async function mutate(
  set: Setter,
  get: Getter,
  userId: string,
  call: (api: NonNullable<ReturnType<typeof useAccountStore.getState>['api']>) => Promise<unknown>,
): Promise<void> {
  const api = useAccountStore.getState().api;
  if (!api?.authenticated) return;
  set({ busy: userId });
  try {
    await call(api);
    await get().load();
  } catch (err) {
    set({ error: mensagem(err) });
  } finally {
    set({ busy: null });
  }
}

function mensagem(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Não foi possível falar com o servidor.';
}
