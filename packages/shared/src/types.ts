/** Shared domain types. Mirrors the data model in STREAMPOLIS SPECs §24. */

export type SceneId =
  | 'central_plaza'
  | 'residential_lobby'
  | 'apartment'
  | 'stream_store'
  | 'agency_tower'
  | 'pk_arena'
  | 'live_room';

export type PresenceStatus =
  | 'offline' | 'online' | 'in_world'
  | 'watching_live' | 'streaming' | 'in_pk';

export type Currency = 'credits' | 'coins';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';

/** Avatar is modular (SPECs §13): one skeleton, swappable parts. */
export interface AvatarConfig {
  bodyPreset: number;      // 0..N proportion presets
  skinTone: number;        // index into palette
  facePreset: number;
  hair: string;            // item id, '' = none
  hairColor: number;       // index into palette
  top: string;
  bottom: string;
  shoes: string;
  accessory: string;
  height: number;          // 0.92..1.08 multiplier
  /**
   * Qual CORPO desenha este avatar. Ausente ou `'v1'` é o corpo procedural.
   *
   * `'v2'` está reservado para o corpo base importado e **não é jogável**: o
   * guarda-roupa inteiro é lofteado das estações do corpo v1, e um jogador de
   * corpo v2 ficaria sem roupa nenhuma. O campo existe agora, e é validado
   * contra POSSE DE ITEM no servidor como qualquer peça, para que vendê-lo um
   * dia seja uma mudança de catálogo e não de arquitetura.
   */
  body?: 'v1' | 'v2';
}

export const DEFAULT_AVATAR: AvatarConfig = {
  bodyPreset: 0,
  skinTone: 3,
  facePreset: 0,
  hair: 'hair_bob_01',
  hairColor: 1,
  top: 'top_tee_01',
  bottom: 'bottom_jeans_01',
  shoes: 'shoes_sneaker_01',
  accessory: '',
  height: 1.0,
  body: 'v1',
};

/** Character needs (PRD §9). Range 0..100. Never hard-blocks play. */
export interface Needs {
  energy: number;
  social: number;
  mood: number;
  comfort: number;
}

export interface PlayerStats {
  level: number;
  xp: number;
  fame: number;
  gifterXp: number;
  gifterLevel: number;
  creatorPoints: number;
  followersCount: number;
}

export interface Wallet {
  credits: number;
  coins: number;
}

/** Gifter Prestige tiers (PRD §17). */
export const GIFTER_TIERS = [
  { level: 0, name: 'Viewer',    xp: 0,       color: '#8a93a6' },
  { level: 1, name: 'Supporter', xp: 500,     color: '#4aa3ff' },
  { level: 2, name: 'Fan',       xp: 2_500,   color: '#39d98a' },
  { level: 3, name: 'VIP',       xp: 12_000,  color: '#b06bff' },
  { level: 4, name: 'Elite',     xp: 50_000,  color: '#ff7a45' },
  { level: 5, name: 'Legend',    xp: 200_000, color: '#ffcc33' },
  { level: 6, name: 'Icon',      xp: 750_000, color: '#ff3d7f' },
] as const;

export type GifterTier = (typeof GIFTER_TIERS)[number];

export function gifterTierFor(xp: number): GifterTier {
  let t: GifterTier = GIFTER_TIERS[0];
  for (const tier of GIFTER_TIERS) if (xp >= tier.xp) t = tier;
  return t;
}

export type AnimState =
  | 'idle' | 'walk' | 'run' | 'sit' | 'wave' | 'clap'
  | 'dance' | 'celebrate' | 'giftReact' | 'pkWin' | 'pkLose';

export type PKPhase = 'WAITING' | 'COUNTDOWN' | 'ACTIVE' | 'OVERTIME' | 'FINISHED';

export const PK_DURATION_MS = 180_000;   // PRD §18
export const PK_OVERTIME_MS = 30_000;
