import { create } from 'zustand';
import { CHAT, PEOPLE } from './mocks.js';
import type { ChatMessage, ChatRateLimit } from './types.js';

interface ChatState {
  messages: ChatMessage[];
  limit: ChatRateLimit;
  draft: string;
  setDraft: (v: string) => void;
  /**
   * Optimistic local echo. The real send goes over the socket and the server
   * decides (SPECs §31); this only exists so the lab is interactive.
   * TODO(network): replace with `room.send('chat', ...)` + server ack.
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
    if (!text || limit.remaining <= 0) return;
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
