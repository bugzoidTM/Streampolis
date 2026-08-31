import { create } from 'zustand';
import type { Toast } from './types.js';

/** Panels that can sit above the 3D canvas. Only one at a time on mobile. */
export type Overlay =
  | null | 'menu' | 'gifts' | 'shop' | 'profile' | 'rankings' | 'avatar' | 'summary' | 'chat';

interface UIState {
  overlay: Overlay;
  /** Chat is a column on desktop and a collapsible drawer on mobile. */
  chatOpen: boolean;
  toasts: Toast[];
  open: (o: Overlay) => void;
  close: () => void;
  toggleChat: () => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

let toastSeq = 0;

export const useUIStore = create<UIState>((set, get) => ({
  overlay: null,
  chatOpen: true,
  toasts: [],
  open: (overlay) => set({ overlay }),
  close: () => set({ overlay: null }),
  toggleChat: () => set({ chatOpen: !get().chatOpen }),
  toast: (t) => set({ toasts: [...get().toasts, { ...t, id: `t${++toastSeq}` }] }),
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}));
