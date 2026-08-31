import { DEFAULT_AVATAR, type AvatarConfig } from '@streampolis/shared';
import { TOP_BUILDERS, BOTTOM_BUILDERS, SHOE_BUILDERS } from '../game/avatar/Wardrobe.js';

/**
 * The regression matrix. Nothing new enters the wardrobe while any of these
 * renders broken — a garment inherits the body's defects, so a hundred new
 * items on a broken body is a hundred broken items.
 *
 * `core` is the full cross product the sprint was scoped around: every body
 * against every basic top, bottom and shoe. `sweep` adds the remaining
 * catalogue items once per body, which catches an item authored outside the
 * shared helpers without paying for another full cross product.
 */

export const MATRIX_BODIES = [0, 1, 2, 3];
export const MATRIX_TOPS = ['top_tee_01', 'top_hoodie_01', 'top_blazer_01'];
export const MATRIX_BOTTOMS = ['bottom_jeans_01', 'bottom_cargo_01', 'bottom_skirt_01'];
export const MATRIX_SHOES = ['shoes_sneaker_01', 'shoes_boot_01', 'shoes_glow_01'];

/**
 * Catalogue items outside the core cross product, checked once per body. Read
 * from the BUILDER REGISTRIES rather than listed by hand: an item added to the
 * wardrobe and forgotten here is an item the gate never sees, and the gate
 * exists precisely because a new garment inherits old defects.
 */
const outside = (registry: Record<string, unknown>, core: string[]) =>
  Object.keys(registry).filter((id) => !core.includes(id));

export interface MatrixEntry {
  index: number;
  label: string;
  group: 'core' | 'sweep';
  config: AvatarConfig;
}

const HAIRS = ['hair_bob_01', 'hair_buzz_01', 'hair_ponytail_01', 'hair_afro_01'];

function entry(
  index: number,
  group: 'core' | 'sweep',
  body: number,
  top: string,
  bottom: string,
  shoes: string,
): MatrixEntry {
  const short = (id: string) => id.replace(/_01$/, '').replace(/^(top|bottom|shoes)_/, '');
  return {
    index,
    label: `b${body}·${short(top)}·${short(bottom)}·${short(shoes)}`,
    group,
    config: {
      ...DEFAULT_AVATAR,
      bodyPreset: body,
      facePreset: body,
      skinTone: [1, 5, 3, 6][body],
      hair: HAIRS[body],
      hairColor: [3, 0, 4, 1][body],
      top,
      bottom,
      shoes,
    },
  };
}

export function buildMatrix(): MatrixEntry[] {
  const out: MatrixEntry[] = [];
  for (const body of MATRIX_BODIES) {
    for (const top of MATRIX_TOPS) {
      for (const bottom of MATRIX_BOTTOMS) {
        for (const shoes of MATRIX_SHOES) {
          out.push(entry(out.length, 'core', body, top, bottom, shoes));
        }
      }
    }
  }
  for (const body of MATRIX_BODIES) {
    for (const top of outside(TOP_BUILDERS, MATRIX_TOPS)) {
      out.push(entry(out.length, 'sweep', body, top, MATRIX_BOTTOMS[0], MATRIX_SHOES[0]));
    }
    for (const bottom of outside(BOTTOM_BUILDERS, MATRIX_BOTTOMS)) {
      out.push(entry(out.length, 'sweep', body, MATRIX_TOPS[0], bottom, MATRIX_SHOES[0]));
    }
    for (const shoes of outside(SHOE_BUILDERS, MATRIX_SHOES)) {
      out.push(entry(out.length, 'sweep', body, MATRIX_TOPS[0], MATRIX_BOTTOMS[0], shoes));
    }
  }
  return out;
}
