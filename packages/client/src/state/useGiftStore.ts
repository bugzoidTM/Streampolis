import { create } from 'zustand';
import { GIFT_CATALOG, type GiftDef } from '@streampolis/shared';

export type GiftTab = 'all' | GiftDef['category'];

interface GiftState {
  tab: GiftTab;
  selectedId: string;
  quantity: number;
  /** Set while a send is in flight so the button cannot double-fire. */
  sending: boolean;
  setTab: (t: GiftTab) => void;
  select: (id: string) => void;
  setQuantity: (q: number) => void;
  /**
   * TODO(api): POST /gifts/send — server debits Coins, credits Creator Points
   * and PK Points, and broadcasts the effect (SPECs §26/§30). No money moves
   * to the recipient (PRD §15); the UI states this next to the button.
   */
  send: () => void;
}

export const QUANTITIES = [1, 5, 10, 50, 100];

export const useGiftStore = create<GiftState>((set) => ({
  tab: 'all',
  selectedId: 'g_heart',
  quantity: 1,
  sending: false,
  setTab: (tab) => set({ tab }),
  select: (selectedId) => set({ selectedId }),
  setQuantity: (quantity) => set({ quantity }),
  send: () => set({ sending: false }),
}));

export const GIFT_TABS: { id: GiftTab; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'basic', label: 'Básicos' },
  { id: 'social', label: 'Sociais' },
  { id: 'premium', label: 'Premium' },
  { id: 'spectacle', label: 'Espetáculo' },
];

export function giftsOf(tab: GiftTab): GiftDef[] {
  return GIFT_CATALOG.filter((g) => g.active && (tab === 'all' || g.category === tab));
}
