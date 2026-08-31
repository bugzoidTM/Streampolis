import * as THREE from 'three';
import { mulberry32 } from '../materials/Noise.js';
import type { MatLib } from './Materials.js';
import { box, boxUV, cyl, merge, place, rbox, type Prop } from './Geometry.js';

export type FacadeStyle = 'townhouse' | 'modern' | 'tower';

export interface BuildingOpts {
  width: number;
  depth: number;
  floors: number;
  style: FacadeStyle;
  seed: number;
  /** Ground-floor sign colour; drives the neon that reads at night. */
  signColor?: number;
  wallTint?: string;
}

const FLOOR_H = 3.15;
const GROUND_H = 4.2;

/**
 * Perimeter block for the plaza.
 *
 * The building is authored facing +Z, origin at ground level on its centre.
 * Only the front and the two returns get detail: the plaza is a closed square,
 * so the backs are never seen and paying for them would be pure waste
 * (SPECs §46).
 */
export function facadeBuilding(lib: MatLib, opts: BuildingOpts): Prop {
  const { width: W, depth: D, floors, style, seed } = opts;
  const rnd = mulberry32(seed * 2654435761);
  const H = GROUND_H + floors * FLOOR_H;
  const front = D / 2;

  const wall: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const frames: THREE.BufferGeometry[] = [];
  const roof: THREE.BufferGeometry[] = [];
  const signs: THREE.BufferGeometry[] = [];
  const awnings: THREE.BufferGeometry[] = [];

  // Main mass. A single box: the interior is never entered in the MVP.
  wall.push(place(box(W, H, D), 0, H / 2, 0));

  // --- Roof line ----------------------------------------------------------
  const parapet = 0.55;
  trim.push(place(box(W + 0.24, 0.34, D + 0.24), 0, H + 0.17, 0));
  trim.push(place(box(W + 0.1, parapet, 0.18), 0, H + 0.34 + parapet / 2, front + 0.02));
  trim.push(place(box(0.18, parapet, D + 0.1), -W / 2 - 0.02, H + 0.34 + parapet / 2, 0));
  trim.push(place(box(0.18, parapet, D + 0.1), W / 2 + 0.02, H + 0.34 + parapet / 2, 0));

  // Rooftop clutter reads as lived-in city from eye level and costs nothing.
  const units = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < units; i++) {
    const uw = 0.8 + rnd() * 0.9;
    roof.push(place(rbox(uw, 0.7, uw * 0.8, 0.05),
      (rnd() - 0.5) * (W - 2.5), H + 0.7, (rnd() - 0.5) * (D - 2.5)));
  }
  if (rnd() > 0.45) {
    const mastH = 1.6 + rnd() * 2.4;
    roof.push(place(cyl(0.04, 0.07, mastH, 6), (rnd() - 0.5) * (W - 3), H + 0.34 + mastH / 2, -1));
  }

  // --- Windows ------------------------------------------------------------
  const bay = style === 'tower' ? 2.0 : 2.35;
  const cols = Math.max(2, Math.floor((W - 1.2) / bay));
  const step = (W - 1.4) / cols;
  const winW = style === 'tower' ? step * 0.86 : Math.min(1.25, step * 0.55);
  const winH = style === 'tower' ? FLOOR_H * 0.72 : 1.65;

  const addWindow = (x: number, y: number, z: number, w: number, h: number, faceZ: number) => {
    // Frame sits proud of the wall; the pane is recessed behind it, so the
    // shadow of the reveal is what makes the facade read as having depth.
    const fr = merge([
      place(box(w + 0.16, 0.09, 0.1), 0, h / 2 + 0.045, 0),
      place(box(w + 0.16, 0.09, 0.1), 0, -h / 2 - 0.045, 0),
      place(box(0.09, h, 0.1), -w / 2 - 0.045, 0, 0),
      place(box(0.09, h, 0.1), w / 2 + 0.045, 0, 0),
    ]);
    boxUV(fr, 0.5);
    frames.push(place(fr, x, y, z + faceZ * 0.03, 0, faceZ > 0 ? 0 : Math.PI, 0));
    const pane = new THREE.PlaneGeometry(w, h);
    if (faceZ < 0) pane.rotateY(Math.PI);
    glass.push(place(pane, x, y, z - faceZ * 0.06));
  };

  for (let f = 0; f < floors; f++) {
    const y = GROUND_H + f * FLOOR_H + FLOOR_H * 0.52;
    for (let c = 0; c < cols; c++) {
      const x = -W / 2 + 0.7 + step * (c + 0.5);
      addWindow(x, y, front, winW, winH, 1);
      if (style === 'townhouse') {
        // Stone sill and lintel: the cheapest way to say "masonry".
        trim.push(place(box(winW + 0.42, 0.1, 0.22), x, y - winH / 2 - 0.12, front + 0.06));
        trim.push(place(box(winW + 0.42, 0.14, 0.16), x, y + winH / 2 + 0.16, front + 0.04));
      }
    }
    if (style === 'modern') {
      // Continuous balcony slab every other floor.
      if (f % 2 === 1) {
        trim.push(place(box(W * 0.72, 0.16, 1.15), 0, y - winH / 2 - 0.16, front + 0.5));
        for (let b = 0; b < 3; b++) {
          frames.push(place(box(W * 0.72, 0.05, 0.05), 0, y - winH / 2 + 0.16 + b * 0.28, front + 1.03));
        }
        frames.push(place(box(0.05, 0.98, 1.1), -W * 0.36, y - winH / 2 + 0.4, front + 0.5));
        frames.push(place(box(0.05, 0.98, 1.1), W * 0.36, y - winH / 2 + 0.4, front + 0.5));
      }
    }
    if (style === 'tower') {
      // Spandrel band tying the glazing into a horizontal ribbon.
      trim.push(place(box(W + 0.08, 0.34, 0.12), 0, GROUND_H + f * FLOOR_H + 0.1, front + 0.04));
    }
  }

  // Side returns get one column of windows so corners are not blank.
  const sideCols = Math.max(1, Math.floor((D - 2) / 3.2));
  for (let f = 0; f < floors; f++) {
    const y = GROUND_H + f * FLOOR_H + FLOOR_H * 0.52;
    for (let c = 0; c < sideCols; c++) {
      const z = -D / 2 + 1.2 + ((D - 2.4) / Math.max(1, sideCols - 1 || 1)) * c;
      for (const sx of [-1, 1]) {
        const fr = merge([
          place(box(0.1, 0.09, winW + 0.16), 0, winH / 2 + 0.045, 0),
          place(box(0.1, 0.09, winW + 0.16), 0, -winH / 2 - 0.045, 0),
          place(box(0.1, winH, 0.09), 0, 0, -winW / 2 - 0.045),
          place(box(0.1, winH, 0.09), 0, 0, winW / 2 + 0.045),
        ]);
        boxUV(fr, 0.5);
        frames.push(place(fr, sx * (W / 2 + 0.03), y, z));
        const pane = new THREE.PlaneGeometry(winW, winH).rotateY(sx * Math.PI / 2);
        glass.push(place(pane, sx * (W / 2 - 0.06), y, z));
      }
    }
  }

  // --- Ground floor -------------------------------------------------------
  const shopW = W - 1.0;
  trim.push(place(box(W + 0.16, 0.42, D + 0.16), 0, GROUND_H - 0.1, 0));   // storefront cornice
  trim.push(place(box(W + 0.12, 0.5, D + 0.12), 0, 0.25, 0));               // plinth
  const shopH = 2.6;
  const shopPane = new THREE.PlaneGeometry(shopW, shopH);
  glass.push(place(shopPane, 0, 0.62 + shopH / 2, front + 0.04));
  const mullions: THREE.BufferGeometry[] = [];
  const bays = Math.max(2, Math.round(shopW / 1.6));
  for (let i = 0; i <= bays; i++) {
    mullions.push(place(box(0.1, shopH + 0.2, 0.14), -shopW / 2 + (shopW / bays) * i, 0.62 + shopH / 2, front + 0.06));
  }
  mullions.push(place(box(shopW + 0.2, 0.12, 0.16), 0, 0.62 + shopH + 0.06, front + 0.06));
  mullions.push(place(box(shopW + 0.2, 0.16, 0.16), 0, 0.6, front + 0.06));
  const mull = merge(mullions);
  boxUV(mull, 0.5);
  frames.push(mull);

  // Doorway at human scale: 2.1 m clear height.
  const doorX = (rnd() - 0.5) * (W * 0.4);
  frames.push(place(box(1.35, 0.12, 0.18), doorX, 2.16, front + 0.09));
  frames.push(place(box(0.12, 2.16, 0.18), doorX - 0.62, 1.08, front + 0.09));
  frames.push(place(box(0.12, 2.16, 0.18), doorX + 0.62, 1.08, front + 0.09));

  if (opts.signColor !== undefined) {
    const sw = Math.min(W * 0.5, 3.4);
    signs.push(place(box(sw, 0.42, 0.1), (rnd() - 0.5) * (W - sw - 1), GROUND_H + 0.55, front + 0.12));
    // A blade sign perpendicular to the facade catches the eye down the street.
    if (rnd() > 0.5) signs.push(place(box(0.09, 1.5, 0.5), -W / 2 + 0.9, GROUND_H + 1.5, front + 0.3));
  }

  if (style !== 'tower' && rnd() > 0.35) {
    const aw = shopW * 0.55;
    awnings.push(place(box(aw, 0.05, 1.3), (rnd() - 0.5) * (W - aw - 1.2), 3.35, front + 0.72, -0.22, 0, 0));
  }

  const out: Prop = [];
  const wallGeo = merge(wall);
  boxUV(wallGeo, style === 'townhouse' ? 2.4 : 3.0);
  out.push({
    geo: wallGeo,
    mat: style === 'townhouse'
      ? lib.brick(opts.wallTint ?? '#9c5340')
      : lib.plaster(opts.wallTint ?? '#cfc7ba'),
  });

  const trimGeo = merge(trim);
  boxUV(trimGeo, 1.2);
  out.push({ geo: trimGeo, mat: lib.concrete('#cdc7bc') });

  const frameGeo = merge(frames);
  boxUV(frameGeo, 0.6);
  out.push({ geo: frameGeo, mat: lib.metal('#3b4048', 0.52, 0.65) });

  out.push({ geo: merge(glass), mat: lib.glass(style === 'tower' ? 0x24384a : 0x1b2733), cast: false });

  const roofGeo = merge(roof);
  boxUV(roofGeo, 0.7);
  out.push({ geo: roofGeo, mat: lib.metal('#5a6069', 0.7, 0.5) });

  if (signs.length) {
    out.push({ geo: merge(signs), mat: lib.emissive(opts.signColor!, 2.6), cast: false });
  }
  if (awnings.length) {
    const g = merge(awnings);
    boxUV(g, 0.5);
    out.push({ geo: g, mat: lib.fabric(rnd() > 0.5 ? '#2f6f5e' : '#8c3b46', 60) });
  }
  return out;
}

/**
 * Distant filler blocks: silhouettes only, no windows, no shadow casting.
 * They exist to close the skyline above the perimeter roofline.
 */
export function backdropBlock(lib: MatLib, w: number, h: number, d: number, seed: number): Prop {
  const rnd = mulberry32(seed);
  const parts = [place(box(w, h, d), 0, h / 2, 0)];
  if (rnd() > 0.5) parts.push(place(box(w * 0.6, h * 0.35, d * 0.6), 0, h + h * 0.175, 0));
  const geo = merge(parts);
  boxUV(geo, 3.5);
  return [{ geo, mat: lib.plaster('#b9b8b6'), cast: false }];
}
