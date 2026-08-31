import { create } from 'zustand';
import { ITEM_CATALOG, type ItemDef, type ItemType } from '@streampolis/shared';

export type ShopTab = 'all' | ItemType;
export type ShopCurrencyFilter = 'any' | 'credits' | 'coins';

interface ShopState {
  tab: ShopTab;
  currency: ShopCurrencyFilter;
  /** Item awaiting purchase confirmation. */
  pending: ItemDef | null;
  setTab: (t: ShopTab) => void;
  setCurrency: (c: ShopCurrencyFilter) => void;
  ask: (item: ItemDef | null) => void;
  /**
   * TODO(api): POST /shop/purchase with an idempotency key (SPECs §27).
   * The UI must never subtract from the wallet on its own.
   */
  confirm: () => void;
}

export const useShopStore = create<ShopState>((set) => ({
  tab: 'all',
  currency: 'any',
  pending: null,
  setTab: (tab) => set({ tab }),
  setCurrency: (currency) => set({ currency }),
  ask: (pending) => set({ pending }),
  confirm: () => set({ pending: null }),
}));

export const SHOP_TABS: { id: ShopTab; label: string }[] = [
  { id: 'all', label: 'Tudo' },
  { id: 'hair', label: 'Cabelo' },
  { id: 'top', label: 'Tops' },
  { id: 'bottom', label: 'Calças' },
  { id: 'shoes', label: 'Calçados' },
  { id: 'accessory', label: 'Acessórios' },
  { id: 'furniture', label: 'Móveis' },
  { id: 'stream_gear', label: 'Equipamento' },
  { id: 'floor', label: 'Pisos' },
  { id: 'wall', label: 'Paredes' },
];

export function shopItems(tab: ShopTab, currency: ShopCurrencyFilter): ItemDef[] {
  return ITEM_CATALOG.filter((i) => {
    if (!i.active) return false;
    if (tab !== 'all' && i.type !== tab) return false;
    if (currency === 'credits' && i.creditsPrice === null) return false;
    if (currency === 'coins' && i.coinsPrice === null) return false;
    return true;
  });
}
