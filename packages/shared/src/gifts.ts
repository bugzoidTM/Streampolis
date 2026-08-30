import type { Rarity } from './types.js';

/** Gift catalog (PRD §13). coinCost is authoritative on the server only. */
export interface GiftDef {
  id: string;
  name: string;
  category: 'basic' | 'social' | 'premium' | 'spectacle';
  coinCost: number;
  creatorPoints: number;
  pkPoints: number;
  animationId: string;
  rarity: Rarity;
  /** Peak simultaneous particles this effect may spawn at High quality. */
  particleBudget: number;
  color: string;
  active: boolean;
}

export const GIFT_CATALOG: GiftDef[] = [
  { id: 'g_rose',    name: 'Rosa',     category: 'basic',     coinCost: 1,     creatorPoints: 1,     pkPoints: 1,     animationId: 'fx_rose',    rarity: 'common',    particleBudget: 120,  color: '#ff4d6d', active: true },
  { id: 'g_coffee',  name: 'Café',     category: 'basic',     coinCost: 5,     creatorPoints: 5,     pkPoints: 5,     animationId: 'fx_coffee',  rarity: 'common',    particleBudget: 160,  color: '#c98a5b', active: true },
  { id: 'g_heart',   name: 'Coração',  category: 'social',    coinCost: 20,    creatorPoints: 20,    pkPoints: 20,    animationId: 'fx_heart',   rarity: 'common',    particleBudget: 300,  color: '#ff2e63', active: true },
  { id: 'g_star',    name: 'Estrela',  category: 'social',    coinCost: 99,    creatorPoints: 99,    pkPoints: 99,    animationId: 'fx_star',    rarity: 'rare',      particleBudget: 500,  color: '#ffd166', active: true },
  { id: 'g_diamond', name: 'Diamante', category: 'premium',   coinCost: 499,   creatorPoints: 499,   pkPoints: 499,   animationId: 'fx_diamond', rarity: 'epic',      particleBudget: 900,  color: '#5ee7ff', active: true },
  { id: 'g_crown',   name: 'Coroa',    category: 'premium',   coinCost: 1_999, creatorPoints: 1_999, pkPoints: 1_999, animationId: 'fx_crown',   rarity: 'legendary', particleBudget: 1400, color: '#ffb703', active: true },
  { id: 'g_rocket',  name: 'Rocket',   category: 'spectacle', coinCost: 9_999, creatorPoints: 9_999, pkPoints: 9_999, animationId: 'fx_rocket',  rarity: 'mythic',    particleBudget: 2400, color: '#7c5cff', active: true },
];

export const GIFT_BY_ID = new Map(GIFT_CATALOG.map((g) => [g.id, g]));

/**
 * Bulk sends collapse into one combined effect (SPECs §47): "Rosa x100" must
 * never instantiate 100 particle systems. Returns the scale factor applied to
 * a single effect instead.
 */
export function combinedEffectScale(quantity: number): number {
  if (quantity <= 1) return 1;
  return Math.min(3.5, 1 + Math.log2(quantity) * 0.42);
}
