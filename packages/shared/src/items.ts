import type { Rarity } from './types.js';

export type ItemType =
  | 'hair' | 'top' | 'bottom' | 'shoes' | 'accessory'
  | 'body'
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

/**
 * O item que libera cada corpo.
 *
 * O corpo é uma PEÇA, não uma preferência: quem valida posse no servidor
 * (`AvatarService`) e quem fabrica o corpo no cliente (`createAvatar`)
 * consultam esta mesma tabela, para que ninguém precise repetir o id em dois
 * lugares — repetir o catálogo em dois lugares já custou um dia neste projeto
 * (a loja mostrava o que a economia não conhecia).
 */
export const BODY_ITEM: Record<'v1' | 'v2', string | null> = {
  v1: null,
  v2: 'body_v2_01',
};

export const ITEM_CATALOG: ItemDef[] = [
  // --- Corpos ---
  // INATIVO de propósito, e não é rascunho: o corpo v2 desenha melhor e não
  // veste NADA da loja (o guarda-roupa é lofteado das estações do corpo v1).
  // Vendê-lo hoje seria vender um avatar que perde as 45 peças que a pessoa
  // comprou. Ele fica aqui, com preço, para o caminho inteiro — catálogo,
  // posse, validação — já existir e ser exercitado; o dia da venda é
  // `active: true` mais o guarda-roupa dele, e nada de arquitetura.
  { id: 'body_v2_01', type: 'body', name: 'Corpo Studio', rarity: 'epic',
    creditsPrice: null, coinsPrice: 1200, assetId: 'body_v2_01', active: false },

  // --- Hair ---
  wear('hair_bob_01',    'hair', 'Bob Curto',      'common', 0,    null),
  wear('hair_ponytail_01','hair','Rabo de Cavalo', 'common', 240,  null),
  wear('hair_afro_01',   'hair', 'Afro',           'common', 240,  null),
  wear('hair_buzz_01',   'hair', 'Raspado',        'common', 0,    null),
  wear('hair_long_01',   'hair', 'Longo Liso',     'rare',   680,  null),
  wear('hair_braids_01', 'hair', 'Tranças',        'rare',   680,  null),
  wear('hair_mohawk_01', 'hair', 'Moicano Neon',   'epic',   null, 320),
  wear('hair_crop_01',   'hair', 'Corte Curto',    'common', 240,  null),
  wear('hair_wave_01',   'hair', 'Ondas Jogadas',  'rare',   680,  null),

  // --- Tops ---
  wear('top_tee_01',     'top', 'Camiseta Lisa',   'common', 0,    null),
  wear('top_hoodie_01',  'top', 'Moletom',         'common', 320,  null),
  wear('top_jacket_01',  'top', 'Jaqueta Bomber',  'rare',   890,  null),
  wear('top_blazer_01',  'top', 'Blazer',          'rare',   890,  null),
  wear('top_holo_01',    'top', 'Top Holográfico', 'epic',   null, 480),
  wear('top_tank_01',    'top', 'Regata',          'common', 220,  null),
  wear('top_shirt_01',   'top', 'Camisa Social',   'common', 360,  null),
  wear('top_knit_01',    'top', 'Tricô Gola Alta', 'rare',   740,  null),
  wear('top_puffer_01',  'top', 'Puffer',          'rare',   940,  null),
  wear('top_varsity_01', 'top', 'Jaqueta College', 'epic',   null, 520),

  // --- Bottoms ---
  wear('bottom_jeans_01','bottom', 'Jeans',        'common', 0,    null),
  wear('bottom_cargo_01','bottom', 'Cargo',        'common', 280,  null),
  wear('bottom_skirt_01','bottom', 'Saia Plissada','common', 280,  null),
  wear('bottom_track_01','bottom', 'Calça Track',  'rare',   620,  null),
  wear('bottom_shorts_01','bottom','Bermuda',      'common', 240,  null),
  wear('bottom_wide_01', 'bottom', 'Pantalona',    'rare',   660,  null),
  wear('bottom_leather_01','bottom','Calça Couro', 'epic',   null, 420),
  wear('bottom_skirtlong_01','bottom','Saia Longa','rare',   660,  null),

  // --- Shoes ---
  wear('shoes_sneaker_01','shoes','Tênis Básico',  'common', 0,    null),
  wear('shoes_boot_01',  'shoes', 'Coturno',       'common', 340,  null),
  wear('shoes_glow_01',  'shoes', 'Tênis Glow',    'epic',   null, 260),
  wear('shoes_chunky_01','shoes', 'Tênis Chunky',  'rare',   720,  null),
  wear('shoes_hitop_01', 'shoes', 'Cano Alto',     'common', 380,  null),
  wear('shoes_loafer_01','shoes', 'Mocassim',      'common', 340,  null),
  wear('shoes_heel_01',  'shoes', 'Salto',         'rare',   700,  null),
  wear('shoes_sandal_01','shoes', 'Sandália',      'common', 200,  null),

  // --- Accessories ---
  wear('acc_glasses_01', 'accessory', 'Óculos',    'common', 180,  null),
  wear('acc_cap_01',     'accessory', 'Boné',      'common', 180,  null),
  wear('acc_headset_01', 'accessory', 'Headset',   'rare',   540,  null),
  wear('acc_halo_01',    'accessory', 'Halo',      'legendary', null, 1200),
  wear('acc_shades_01',  'accessory', 'Óculos Escuros', 'common', 240, null),
  wear('acc_beanie_01',  'accessory', 'Gorro',     'common', 200,  null),
  wear('acc_earrings_01','accessory', 'Argolas',   'common', 220,  null),
  wear('acc_chain_01',   'accessory', 'Corrente',  'rare',   580,  null),
  wear('acc_scarf_01',   'accessory', 'Cachecol',  'common', 260,  null),
  wear('acc_mask_01',    'accessory', 'Bandana',   'rare',   520,  null),

  // --- Furniture ---
  furn('fur_sofa_01',    'Sofá Modular',  'common', 900,  null, [3, 2]),
  furn('fur_sofa_02',    'Sofá de Dois',  'common', 700,  null, [3, 2]),
  furn('fur_chair_01',   'Poltrona',      'common', 420,  null, [1, 1]),
  furn('fur_stool_01',   'Banqueta',      'common', 180,  null, [1, 1]),
  furn('fur_deskchair_01','Cadeira Gamer','common', 520,  null, [1, 1]),
  furn('fur_table_01',   'Mesa de Centro','common', 380,  null, [2, 1]),
  furn('fur_bed_01',     'Cama',          'common', 1200, null, [2, 3]),
  furn('fur_rug_01',     'Tapete',        'common', 260,  null, [3, 2]),
  furn('fur_rug_02',     'Tapete Grande', 'common', 380,  null, [4, 3]),
  furn('fur_plant_01',   'Planta',        'common', 190,  null, [1, 1]),
  furn('fur_planttall_01','Planta Alta',  'common', 320,  null, [1, 1]),
  furn('fur_shelf_01',   'Estante',       'common', 640,  null, [2, 1]),
  furn('fur_lamp_01',    'Luminária',     'common', 220,  null, [1, 1]),
  furn('fur_ceiling_01', 'Pendente',      'common', 240,  null, [1, 1]),
  furn('fur_desk_01',    'Mesa de Setup', 'rare',   1400, null, [2, 1]),
  furn('fur_tv_01',      'TV',            'rare',   1100, null, [2, 1]),
  furn('fur_neon_01',    'Neon de Parede','rare',   null, 180,  [2, 1]),
  furn('fur_led_01',     'Fita LED RGB',  'common', 280,  null, [3, 1]),
  furn('fur_art_01',     'Quadro',        'common', 240,  null, [1, 1]),
  furn('fur_art_02',     'Quadro Largo',  'common', 340,  null, [2, 1]),
  furn('fur_books_01',   'Livros e Caneca','common', 120,  null, [1, 1]),

  // --- Stream gear ---
  { id: 'gear_ring_01',  type: 'stream_gear', name: 'Ring Light',   rarity: 'rare', creditsPrice: 1600, coinsPrice: null, assetId: 'gear_ring_01',  footprint: [1, 1], active: true },
  { id: 'gear_backdrop_01', type: 'stream_gear', name: 'Backdrop LED', rarity: 'epic', creditsPrice: null, coinsPrice: 640, assetId: 'gear_backdrop_01', footprint: [4, 1], active: true },
  { id: 'gear_pc_01',    type: 'stream_gear', name: 'PC Gamer',     rarity: 'rare', creditsPrice: 1900, coinsPrice: null, assetId: 'gear_pc_01',    footprint: [1, 1], active: true },
  { id: 'gear_mic_01',   type: 'stream_gear', name: 'Microfone',    rarity: 'rare', creditsPrice: 980,  coinsPrice: null, assetId: 'gear_mic_01',   footprint: [1, 1], active: true },
  { id: 'gear_cam_01',   type: 'stream_gear', name: 'Câmera',       rarity: 'rare', creditsPrice: 1450, coinsPrice: null, assetId: 'gear_cam_01',   footprint: [1, 1], active: true },
  { id: 'gear_monitor_01', type: 'stream_gear', name: 'Monitor',    rarity: 'common', creditsPrice: 760, coinsPrice: null, assetId: 'gear_monitor_01', footprint: [1, 1], active: true },

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
