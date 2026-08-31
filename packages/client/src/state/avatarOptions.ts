/**
 * Option lists for the avatar creator.
 *
 * `AvatarConfig` stores *indices*, so the index is the contract with the 3D
 * builder — these hexes only need to be close enough for the swatch to read as
 * the same colour. They mirror `game/avatar/Materials.ts`; duplicated on
 * purpose so a UI build never pulls Three.js in just to draw eight circles.
 */
import { ITEM_CATALOG, type ItemDef, type ItemType } from '@streampolis/shared';

export const SKIN_SWATCHES = [
  '#f6dcc8', '#f0cdb0', '#e5b596', '#d29b78',
  '#b87d5b', '#95603f', '#6f452c', '#4d2f1e',
];

export const HAIR_SWATCHES = [
  '#1b1614', '#3a2a20', '#6b452a', '#a8703c',
  '#d9a441', '#e8dcc8', '#8f2f3f', '#2f5fa8',
  '#6b2fa8', '#2fa87e',
];

export const BODY_PRESET_LABELS = ['Padrão', 'Robusto', 'Esguio', 'Atlético'];
export const FACE_PRESET_LABELS = ['Suave', 'Angular', 'Redondo', 'Marcado'];

export const wearablesOfType = (t: ItemType): ItemDef[] =>
  ITEM_CATALOG.filter((i) => i.type === t && i.active);

/** Fallback colour for a garment chip when the item has no swatch of its own. */
export function itemSwatch(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 58%)`;
}
