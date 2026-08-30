import type { Rarity } from './types.js';

export type ItemType =
  | 'hair' | 'top' | 'bottom' | 'shoes' | 'accessory'
  | 'furniture' | 'floor' | 'wall' | 'decor' | 'stream_gear';

export interface ItemDef {
  id: string;
  type: ItemType;
  name: string;
  rarity: Rarity;
  creditsPrice: number | null;
  coinsPrice: number | null;
  /** Procedural generator key — the MVP ships no external GLBs (see docs/ART.md). */
  assetId: string;
  /** Grid footprint in cells for placeables (SPECs: grid + snap points). */
  footprint?: [number, number];
  active: boolean;
}

const wear = (
  id: string, type: ItemType, name: string, rarity: Rarity,
  credits: number | null, coins: number | null,
): ItemDef => ({ id, type, name, rarity, creditsPrice: credits, coinsPrice: coins, assetId: id, active: true });

const furn = (
  id: string, name: string, rarity: Rarity, credits: number | null,
  coins: number | null, footprint: [number, number],
): ItemDef => ({ id, type: 'furniture', name, rarity, creditsPrice: credits, coinsPrice: coins, assetId: id, footprint, active: true });

export const ITEM_CATALOG: ItemDef[] = [
  // --- Hair ---
  wear('hair_bob_01',    'hair', 'Bob Curto',      'common', 0,    null),
  wear('hair_ponytail_01','hair','Rabo de Cavalo', 'common', 240,  null),
  wear('hair_afro_01',   'hair', 'Afro',           'common', 240,  null),
  wear('hair_buzz_01',   'hair', 'Raspado',        'common', 0,    null),
  wear('hair_long_01',   'hair', 'Longo Liso',     'rare',   680,  null),
  wear('hair_braids_01', 'hair', 'Tranças',        'rare',   680,  null),
  wear('hair_mohawk_01', 'hair', 'Moicano Neon',   'epic',   null, 320),

  // --- Tops ---
  wear('top_tee_01',     'top', 'Camiseta Lisa',   'common', 0,    null),
  wear('top_hoodie_01',  'top', 'Moletom',         'common', 320,  null),
  wear('top_jacket_01',  'top', 'Jaqueta Bomber',  'rare',   890,  null),
  wear('top_blazer_01',  'top', 'Blazer',          'rare',   890,  null),
  wear('top_holo_01',    'top', 'Top Holográfico', 'epic',   null, 480),

  // --- Bottoms ---
  wear('bottom_jeans_01','bottom', 'Jeans',        'common', 0,    null),
  wear('bottom_cargo_01','bottom', 'Cargo',        'common', 280,  null),
  wear('bottom_skirt_01','bottom', 'Saia Plissada','common', 280,  null),
  wear('bottom_track_01','bottom', 'Calça Track',  'rare',   620,  null),

  // --- Shoes ---
  wear('shoes_sneaker_01','shoes','Tênis Básico',  'common', 0,    null),
  wear('shoes_boot_01',  'shoes', 'Coturno',       'common', 340,  null),
  wear('shoes_glow_01',  'shoes', 'Tênis Glow',    'epic',   null, 260),

  // --- Accessories ---
  wear('acc_glasses_01', 'accessory', 'Óculos',    'common', 180,  null),
  wear('acc_cap_01',     'accessory', 'Boné',      'common', 180,  null),
  wear('acc_headset_01', 'accessory', 'Headset',   'rare',   540,  null),
  wear('acc_halo_01',    'accessory', 'Halo',      'legendary', null, 1200),

  // --- Furniture ---
  furn('fur_sofa_01',    'Sofá Modular',  'common', 900,  null, [3, 2]),
  furn('fur_chair_01',   'Poltrona',      'common', 420,  null, [1, 1]),
  furn('fur_table_01',   'Mesa de Centro','common', 380,  null, [2, 1]),
  furn('fur_bed_01',     'Cama',          'common', 1200, null, [2, 3]),
  furn('fur_rug_01',     'Tapete',        'common', 260,  null, [3, 2]),
  furn('fur_plant_01',   'Planta',        'common', 190,  null, [1, 1]),
  furn('fur_shelf_01',   'Estante',       'common', 640,  null, [2, 1]),
  furn('fur_lamp_01',    'Luminária',     'common', 220,  null, [1, 1]),
  furn('fur_desk_01',    'Mesa de Setup', 'rare',   1400, null, [2, 1]),
  furn('fur_neon_01',    'Neon de Parede','rare',   null, 180,  [2, 1]),

  // --- Stream gear ---
  { id: 'gear_ring_01',  type: 'stream_gear', name: 'Ring Light',   rarity: 'rare', creditsPrice: 1600, coinsPrice: null, assetId: 'gear_ring_01',  footprint: [1, 1], active: true },
  { id: 'gear_backdrop_01', type: 'stream_gear', name: 'Backdrop LED', rarity: 'epic', creditsPrice: null, coinsPrice: 640, assetId: 'gear_backdrop_01', footprint: [4, 1], active: true },

  // --- Surfaces ---
  { id: 'floor_wood_01',  type: 'floor', name: 'Piso Madeira',  rarity: 'common', creditsPrice: 0,   coinsPrice: null, assetId: 'floor_wood_01',  active: true },
  { id: 'floor_tile_01',  type: 'floor', name: 'Piso Cerâmica', rarity: 'common', creditsPrice: 300, coinsPrice: null, assetId: 'floor_tile_01',  active: true },
  { id: 'floor_carpet_01',type: 'floor', name: 'Carpete',       rarity: 'common', creditsPrice: 300, coinsPrice: null, assetId: 'floor_carpet_01',active: true },
  { id: 'wall_paint_01',  type: 'wall',  name: 'Parede Pintada', rarity: 'common', creditsPrice: 0, coinsPrice: null, assetId: 'wall_paint_01',  active: true },
  { id: 'wall_brick_01',  type: 'wall',  name: 'Tijolo Aparente', rarity: 'common', creditsPrice: 340, coinsPrice: null, assetId: 'wall_brick_01', active: true },
  { id: 'wall_panel_01',  type: 'wall',  name: 'Painel Ripado', rarity: 'rare', creditsPrice: 720, coinsPrice: null, assetId: 'wall_panel_01',  active: true },
];

export const ITEM_BY_ID = new Map(ITEM_CATALOG.map((i) => [i.id, i]));
export const itemsOfType = (t: ItemType) => ITEM_CATALOG.filter((i) => i.type === t && i.active);
