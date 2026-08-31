import { create } from 'zustand';
import { activeConnection } from './useSessionStore.js';
import { CHAT, PEOPLE } from './mocks.js';
import type { ChatMessage, ChatRateLimit } from './types.js';

interface ChatState {
  messages: ChatMessage[];
  limit: ChatRateLimit;
  draft: string;
  setDraft: (v: string) => void;
  /**
   * Manda a mensagem. Conectado, ela vai pelo socket e VOLTA pelo servidor —
   * sem eco local, porque o servidor é quem decide se a mensagem existe, se foi
   * filtrada e em que ordem ela entra (SPECs §31, §39). Sem conexão, o eco
   * local mantém o laboratório interativo.
   */
  send: () => void;
  /** TODO(network): push from the room's `chat` message handler. */
  receive: (m: ChatMessage) => void;
}

const MAX_BUFFER = 200;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: CHAT,
  limit: { remaining: 3, capacity: 5, resetAt: Date.now() + 6_400, maxLength: 140 },
  draft: '',
  setDraft: (v) => set({ draft: v.slice(0, get().limit.maxLength) }),
  send: () => {
    const { draft, limit, messages } = get();
    const text = draft.trim();
    if (!text) return;

    const connection = activeConnection();
    if (connection) {
      connection.chat(text);
      set({ draft: '' });
      return;
    }

    if (limit.remaining <= 0) return;
    const msg: ChatMessage = {
      id: `local_${Date.now()}`, kind: 'user', sender: PEOPLE.me, text, ts: Date.now(),
    };
    set({
      draft: '',
      messages: [...messages, msg].slice(-MAX_BUFFER),
      limit: { ...limit, remaining: limit.remaining - 1, resetAt: Date.now() + 6_400 },
    });
  },
  receive: (m) => set({ messages: [...get().messages, m].slice(-MAX_BUFFER) }),
}));
