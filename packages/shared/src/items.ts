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

  // Guarda-roupa do avatar v2: peças fatiadas dos pacotes Ultimate Modular
  // (CC0) por `node tools/assets/characters.mjs`. O id é o nome do arquivo em
  // `assets/wardrobe/`, e a lista é GERADA — escrevê-la à mão seria o catálogo
  // existindo em dois lugares, defeito que já custou um dia a este projeto.
  //
  // `hair` aqui é a CABEÇA inteira: no pacote, rosto e cabelo vêm na mesma
  // malha. O slot do protocolo não mudou de nome para não mexer no token
  // assinado, no schema da sala e no banco de uma vez só. E `accessory` ficou
  // sem itens: o pacote não traz acessório avulso.
  //
  // <<< GERADO: guarda-roupa — daqui até o marcador de fim é reescrito.
  wear('f_adventurer_top', 'top', 'Blusa Aventureiro F', 'common', 320, null),
  wear('f_adventurer_bottom', 'bottom', 'Calça Aventureiro F', 'common', 320, null),
  wear('f_adventurer_head', 'hair', 'Cabeça Aventureiro F', 'rare', 680, null),
  wear('f_adventurer_shoes', 'shoes', 'Calçado Aventureiro F', 'common', 320, null),
  wear('f_animated_woman_niitlv9nxs_head', 'hair', 'Cabeça Clássica II F', 'rare', 680, null),
  wear('f_animated_woman_niitlv9nxs_top', 'top', 'Blusa Clássica II F', 'common', 320, null),
  wear('f_animated_woman_niitlv9nxs_shoes', 'shoes', 'Calçado Clássica II F', 'common', 320, null),
  wear('f_animated_woman_niitlv9nxs_bottom', 'bottom', 'Calça Clássica II F', 'common', 320, null),
  wear('f_animated_woman_top', 'top', 'Blusa Clássica F', 'common', 0, null),
  wear('f_animated_woman_shoes', 'shoes', 'Calçado Clássica F', 'common', 0, null),
  wear('f_animated_woman_head', 'hair', 'Cabeça Clássica F', 'common', 0, null),
  wear('f_animated_woman_bottom', 'bottom', 'Calça Clássica F', 'common', 0, null),
  wear('f_medieval_top', 'top', 'Blusa Medieval F', 'common', 320, null),
  wear('f_medieval_head', 'hair', 'Cabeça Medieval F', 'rare', 680, null),
  wear('f_medieval_bottom', 'bottom', 'Calça Medieval F', 'common', 320, null),
  wear('f_medieval_shoes', 'shoes', 'Calçado Medieval F', 'common', 320, null),
  wear('f_punk_top', 'top', 'Blusa Punk F', 'common', 320, null),
  wear('f_punk_head', 'hair', 'Cabeça Punk F', 'rare', 680, null),
  wear('f_punk_bottom', 'bottom', 'Calça Punk F', 'common', 320, null),
  wear('f_punk_shoes', 'shoes', 'Calçado Punk F', 'common', 320, null),
  wear('f_sci_fi_character_top', 'top', 'Blusa Sci-Fi F', 'epic', null, 320),
  wear('f_sci_fi_character_shoes', 'shoes', 'Calçado Sci-Fi F', 'epic', null, 320),
  wear('f_sci_fi_character_head', 'hair', 'Cabeça Sci-Fi F', 'epic', null, 320),
  wear('f_sci_fi_character_bottom', 'bottom', 'Calça Sci-Fi F', 'epic', null, 320),
  wear('f_soldier_top', 'top', 'Blusa Militar F', 'epic', null, 320),
  wear('f_soldier_shoes', 'shoes', 'Calçado Militar F', 'epic', null, 320),
  wear('f_soldier_bottom', 'bottom', 'Calça Militar F', 'epic', null, 320),
  wear('f_soldier_head', 'hair', 'Cabeça Militar F', 'epic', null, 320),
  wear('f_suit_top', 'top', 'Blusa Alfaiataria F', 'common', 320, null),
  wear('f_suit_shoes', 'shoes', 'Calçado Alfaiataria F', 'common', 320, null),
  wear('f_suit_bottom', 'bottom', 'Calça Alfaiataria F', 'common', 320, null),
  wear('f_suit_head', 'hair', 'Cabeça Alfaiataria F', 'rare', 680, null),
  wear('f_witch_top', 'top', 'Blusa Bruxa F', 'epic', null, 320),
  wear('f_witch_head', 'hair', 'Cabeça Bruxa F', 'epic', null, 320),
  wear('f_witch_bottom', 'bottom', 'Calça Bruxa F', 'epic', null, 320),
  wear('f_witch_shoes', 'shoes', 'Calçado Bruxa F', 'epic', null, 320),
  wear('f_worker_top', 'top', 'Blusa Operário F', 'common', 320, null),
  wear('f_worker_shoes', 'shoes', 'Calçado Operário F', 'common', 320, null),
  wear('f_worker_head', 'hair', 'Cabeça Operário F', 'rare', 680, null),
  wear('f_worker_bottom', 'bottom', 'Calça Operário F', 'common', 320, null),
  wear('m_adventurer_shoes', 'shoes', 'Calçado Aventureiro M', 'common', 320, null),
  wear('m_adventurer_bottom', 'bottom', 'Calça Aventureiro M', 'common', 320, null),
  wear('m_adventurer_top', 'top', 'Blusa Aventureiro M', 'common', 320, null),
  wear('m_adventurer_head', 'hair', 'Cabeça Aventureiro M', 'rare', 680, null),
  wear('m_astronaut_shoes', 'shoes', 'Calçado Astronauta M', 'epic', null, 320),
  wear('m_astronaut_bottom', 'bottom', 'Calça Astronauta M', 'epic', null, 320),
  wear('m_astronaut_top', 'top', 'Blusa Astronauta M', 'epic', null, 320),
  wear('m_astronaut_head', 'hair', 'Cabeça Astronauta M', 'epic', null, 320),
  wear('m_beach_character_shoes', 'shoes', 'Calçado Praia M', 'common', 320, null),
  wear('m_beach_character_bottom', 'bottom', 'Calça Praia M', 'common', 320, null),
  wear('m_beach_character_top', 'top', 'Blusa Praia M', 'common', 320, null),
  wear('m_beach_character_head', 'hair', 'Cabeça Praia M', 'rare', 680, null),
  wear('m_business_man_bottom', 'bottom', 'Calça Executivo M', 'common', 320, null),
  wear('m_business_man_top', 'top', 'Blusa Executivo M', 'common', 320, null),
  wear('m_business_man_shoes', 'shoes', 'Calçado Executivo M', 'common', 320, null),
  wear('m_business_man_head', 'hair', 'Cabeça Executivo M', 'rare', 680, null),
  wear('m_casual_character_bottom', 'bottom', 'Calça Casual M', 'common', 0, null),
  wear('m_casual_character_shoes', 'shoes', 'Calçado Casual M', 'common', 0, null),
  wear('m_casual_character_top', 'top', 'Blusa Casual M', 'common', 0, null),
  wear('m_casual_character_head', 'hair', 'Cabeça Casual M', 'common', 0, null),
  wear('m_farmer_shoes', 'shoes', 'Calçado Fazendeiro M', 'common', 320, null),
  wear('m_farmer_top', 'top', 'Blusa Fazendeiro M', 'common', 320, null),
  wear('m_farmer_head', 'hair', 'Cabeça Fazendeiro M', 'rare', 680, null),
  wear('m_hoodie_character_shoes', 'shoes', 'Calçado Moletom M', 'common', 320, null),
  wear('m_hoodie_character_top', 'top', 'Blusa Moletom M', 'common', 320, null),
  wear('m_hoodie_character_bottom', 'bottom', 'Calça Moletom M', 'common', 320, null),
  wear('m_hoodie_character_head', 'hair', 'Cabeça Moletom M', 'rare', 680, null),
  wear('m_king_shoes', 'shoes', 'Calçado Realeza M', 'epic', null, 320),
  wear('m_king_bottom', 'bottom', 'Calça Realeza M', 'epic', null, 320),
  wear('m_king_top', 'top', 'Blusa Realeza M', 'epic', null, 320),
  wear('m_king_head', 'hair', 'Cabeça Realeza M', 'epic', null, 320),
  wear('m_punk_shoes', 'shoes', 'Calçado Punk M', 'common', 320, null),
  wear('m_punk_top', 'top', 'Blusa Punk M', 'common', 320, null),
  wear('m_punk_bottom', 'bottom', 'Calça Punk M', 'common', 320, null),
  wear('m_punk_head', 'hair', 'Cabeça Punk M', 'rare', 680, null),
  wear('m_swat_bottom', 'bottom', 'Calça Tático M', 'epic', null, 320),
  wear('m_swat_top', 'top', 'Blusa Tático M', 'epic', null, 320),
  wear('m_swat_head', 'hair', 'Cabeça Tático M', 'epic', null, 320),
  wear('m_swat_shoes', 'shoes', 'Calçado Tático M', 'epic', null, 320),
  wear('m_worker_shoes', 'shoes', 'Calçado Operário M', 'common', 320, null),
  wear('m_worker_bottom', 'bottom', 'Calça Operário M', 'common', 320, null),
  wear('m_worker_top', 'top', 'Blusa Operário M', 'common', 320, null),
  wear('m_worker_head', 'hair', 'Cabeça Operário M', 'rare', 680, null),
  // >>> GERADO

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
