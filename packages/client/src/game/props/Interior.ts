import * as THREE from 'three';
import { mulberry32 } from '../materials/Noise.js';
import type { MatLib } from './Materials.js';
import { box, boxUV, cyl, merge, place, rbox, sph, type Prop } from './Geometry.js';

/**
 * Apartment furniture, authored to the catalogue in
 * `packages/shared/src/items.ts`. Footprints there are expressed in grid
 * cells; one cell is `GRID` metres, and every builder below keeps its bounding
 * box inside the declared footprint so placement never has to guess.
 *
 * Seat heights are 0.42–0.45 m, worktops 0.74 m, counters 0.90 m: the avatar
 * is 1.67 m tall and furniture that ignores that reads as a doll's house.
 */
export const GRID = 0.6;

/** Wall opening in wall-local coordinates (origin at the bottom-left corner). */
export interface Opening { x: number; y: number; w: number; h: number }

/**
 * A wall pierced by doors and windows, built as solid pieces rather than by
 * subtracting volumes: CSG at runtime would cost more than the whole scene.
 * Openings must not overlap horizontally.
 */
export function wallPanel(
  width: number, height: number, thickness: number, openings: Opening[] = [],
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const sorted = [...openings].sort((a, b) => a.x - b.x);
  let cursor = -width / 2;
  for (const o of sorted) {
    const left = o.x - o.w / 2;
    if (left > cursor + 1e-4) {
      const w = left - cursor;
      parts.push(place(box(w, height, thickness), cursor + w / 2, height / 2, 0));
    }
    if (o.y > 1e-4) parts.push(place(box(o.w, o.y, thickness), o.x, o.y / 2, 0));
    const topH = height - (o.y + o.h);
    if (topH > 1e-4) parts.push(place(box(o.w, topH, thickness), o.x, o.y + o.h + topH / 2, 0));
    cursor = o.x + o.w / 2;
  }
  if (cursor < width / 2 - 1e-4) {
    const w = width / 2 - cursor;
    parts.push(place(box(w, height, thickness), cursor + w / 2, height / 2, 0));
  }
  const geo = merge(parts);
  boxUV(geo, 1.0);
  return geo;
}

// --------------------------------------------------------------------------
// Seating
// --------------------------------------------------------------------------
export function sofa(lib: MatLib, w = 1.92, tint = '#4a5a78'): Prop {
  const d = 0.88, seatH = 0.42;
  const shell = [
    place(rbox(w, 0.22, d, 0.06), 0, seatH - 0.11, 0),                      // seat deck
    place(rbox(w, 0.62, 0.2, 0.07), 0, seatH + 0.31, -d / 2 + 0.1),          // back
    place(rbox(0.19, 0.55, d, 0.07), -w / 2 + 0.095, seatH + 0.06, 0),       // arms
    place(rbox(0.19, 0.55, d, 0.07), w / 2 - 0.095, seatH + 0.06, 0),
  ];
  const cushions: THREE.BufferGeometry[] = [];
  const seats = w > 1.6 ? 3 : 2;
  const cw = (w - 0.42) / seats;
  for (let i = 0; i < seats; i++) {
    const x = -w / 2 + 0.21 + cw * (i + 0.5);
    cushions.push(place(rbox(cw - 0.03, 0.16, d - 0.24, 0.06), x, seatH + 0.08, 0.06));
    cushions.push(place(rbox(cw - 0.06, 0.42, 0.16, 0.06), x, seatH + 0.34, -d / 2 + 0.22, -0.16, 0, 0));
  }
  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    legs.push(place(cyl(0.026, 0.034, seatH - 0.22, 8), sx * (w / 2 - 0.14), (seatH - 0.22) / 2, sz * (d / 2 - 0.14)));
  }
  const body = merge(shell);
  boxUV(body, 0.45);
  const cush = merge(cushions);
  boxUV(cush, 0.45);
  const leg = merge(legs);
  return [
    { geo: body, mat: lib.fabric(tint, 110) },
    { geo: cush, mat: lib.fabric(tint, 90) },
    { geo: leg, mat: lib.wood('#7a5334') },
  ];
}

export function armchair(lib: MatLib, tint = '#7a5c8a'): Prop {
  const parts = sofa(lib, 0.86, tint);
  return parts;
}

export function stool(lib: MatLib, h = 0.62): Prop {
  const seat = place(cyl(0.19, 0.18, 0.07, 16), 0, h, 0);
  boxUV(seat, 0.4);
  const legs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = cyl(0.02, 0.025, h, 8);
    leg.rotateX(Math.cos(a) * 0.13);
    leg.rotateZ(-Math.sin(a) * 0.13);
    legs.push(place(leg, Math.sin(a) * 0.1, h / 2, Math.cos(a) * 0.1));
  }
  legs.push(place(new THREE.TorusGeometry(0.15, 0.012, 6, 16).rotateX(Math.PI / 2), 0, h * 0.42, 0));
  return [
    { geo: seat, mat: lib.wood('#a9784b') },
    { geo: merge(legs), mat: lib.metal('#33383f', 0.5, 0.8) },
  ];
}

export function deskChair(lib: MatLib): Prop {
  const seatH = 0.46;
  const shell = [
    place(rbox(0.5, 0.09, 0.48, 0.04), 0, seatH, 0),
    place(rbox(0.46, 0.62, 0.09, 0.04), 0, seatH + 0.36, -0.22, -0.12, 0, 0),
    place(rbox(0.09, 0.06, 0.3, 0.03), -0.27, seatH + 0.17, -0.02),
    place(rbox(0.09, 0.06, 0.3, 0.03), 0.27, seatH + 0.17, -0.02),
  ];
  const frame: THREE.BufferGeometry[] = [
    place(cyl(0.035, 0.045, seatH - 0.14, 10), 0, (seatH - 0.14) / 2 + 0.06, 0),
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    frame.push(place(box(0.05, 0.045, 0.26), Math.sin(a) * 0.13, 0.06, Math.cos(a) * 0.13, 0, -a, 0));
    frame.push(place(sph(0.032, 8, 6), Math.sin(a) * 0.25, 0.035, Math.cos(a) * 0.25));
  }
  const body = merge(shell);
  boxUV(body, 0.35);
  return [
    { geo: body, mat: lib.fabric('#2c3038', 130) },
    { geo: merge(frame), mat: lib.metal('#26292e', 0.45, 0.85) },
  ];
}

// --------------------------------------------------------------------------
// Tables and storage
// --------------------------------------------------------------------------
export function coffeeTable(lib: MatLib, w = 1.1, d = 0.6): Prop {
  const h = 0.42;
  const top = place(rbox(w, 0.05, d, 0.02), 0, h, 0);
  boxUV(top, 0.5);
  const shelf = place(box(w - 0.24, 0.03, d - 0.18), 0, 0.16, 0);
  boxUV(shelf, 0.5);
  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    legs.push(place(cyl(0.022, 0.028, h, 8), sx * (w / 2 - 0.09), h / 2, sz * (d / 2 - 0.08)));
  }
  return [
    { geo: merge([top, shelf]), mat: lib.wood('#b0794f') },
    { geo: merge(legs), mat: lib.metal('#2f3338', 0.5, 0.8) },
  ];
}

export function desk(lib: MatLib, w = 1.4, d = 0.68): Prop {
  const h = 0.74;
  const top = place(rbox(w, 0.045, d, 0.015), 0, h, 0);
  boxUV(top, 0.5);
  const frame: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    frame.push(place(box(0.05, h - 0.05, d - 0.1), sx * (w / 2 - 0.06), (h - 0.05) / 2, 0));
    frame.push(place(box(0.06, 0.04, d - 0.06), sx * (w / 2 - 0.06), 0.02, 0));
  }
  frame.push(place(box(w - 0.3, 0.04, 0.05), 0, h - 0.12, -d / 2 + 0.08));
  return [
    { geo: top, mat: lib.wood('#c08b58') },
    { geo: merge(frame), mat: lib.metal('#2b2f35', 0.5, 0.8) },
  ];
}

export function shelf(lib: MatLib, w = 1.2, h = 1.9, d = 0.32): Prop {
  const t = 0.035;
  const carcass = [
    place(box(t, h, d), -w / 2 + t / 2, h / 2, 0),
    place(box(t, h, d), w / 2 - t / 2, h / 2, 0),
    place(box(w, t, d), 0, h - t / 2, 0),
    place(box(w, t, d), 0, t / 2, 0),
    place(box(w, h, 0.014), 0, h / 2, -d / 2 + 0.007),
  ];
  const shelves = 4;
  for (let i = 1; i < shelves; i++) {
    carcass.push(place(box(w - t * 2, t, d - 0.02), 0, (h / shelves) * i, 0.01));
  }
  const wood = merge(carcass);
  boxUV(wood, 0.5);

  // Books: three colour groups so one merged geometry still looks varied.
  const rnd = mulberry32(20260830);
  const groups: THREE.BufferGeometry[][] = [[], [], []];
  for (let s = 0; s < shelves; s++) {
    let x = -w / 2 + 0.09;
    const y = (h / shelves) * s + t;
    while (x < w / 2 - 0.16) {
      const bw = 0.026 + rnd() * 0.034;
      const bh = 0.19 + rnd() * 0.09;
      const lean = rnd() > 0.88 ? 0.22 : 0;
      groups[Math.floor(rnd() * 3)].push(
        place(box(bw, bh, 0.17 + rnd() * 0.05), x + bw / 2, y + bh / 2, 0.02, 0, 0, lean));
      x += bw + 0.006;
      if (rnd() > 0.93) x += 0.1;
    }
  }
  const colors = [0x9c4a3c, 0x2f5f7a, 0xc9a24b];
  return [
    { geo: wood, mat: lib.wood('#8f6340') },
    ...groups.map((g, i) => ({ geo: merge(g), mat: lib.painted(colors[i], 0.8) })),
  ];
}

export function kitchenette(lib: MatLib, w = 2.4): Prop {
  const h = 0.9, d = 0.6;
  const carcass = [
    place(box(w, h - 0.1, d), 0, (h - 0.1) / 2 + 0.1, 0),
    place(box(w - 0.08, 0.1, d - 0.08), 0, 0.05, 0),
  ];
  const doors: THREE.BufferGeometry[] = [];
  const bays = Math.round(w / 0.6);
  for (let i = 0; i < bays; i++) {
    doors.push(place(rbox(w / bays - 0.02, h - 0.16, 0.02, 0.008),
      -w / 2 + (w / bays) * (i + 0.5), (h - 0.1) / 2 + 0.12, d / 2 + 0.011));
  }
  const top = place(rbox(w + 0.04, 0.05, d + 0.04, 0.012), 0, h + 0.025, 0);
  boxUV(top, 0.6);
  // Upper cabinets leave 0.55 m of splashback, the standard clearance.
  const upper = [
    place(box(w * 0.72, 0.68, 0.34), -w * 0.1, h + 0.55 + 0.34, -d / 2 + 0.17),
    place(box(w * 0.72, 0.03, 0.36), -w * 0.1, h + 0.55, -d / 2 + 0.18),
  ];
  const metal = [
    place(box(0.36, 0.02, 0.3), w / 2 - 0.4, h + 0.045, 0),                 // sink
    place(cyl(0.018, 0.018, 0.28, 8), w / 2 - 0.4, h + 0.19, -0.16),
    place(cyl(0.016, 0.016, 0.14, 8).rotateX(Math.PI / 2), w / 2 - 0.4, h + 0.32, -0.1),
  ];
  for (let i = 0; i < bays; i++) {
    metal.push(place(box(w / bays - 0.18, 0.018, 0.018),
      -w / 2 + (w / bays) * (i + 0.5), h - 0.18, d / 2 + 0.03));
  }
  const body = merge([...carcass, ...upper]);
  boxUV(body, 0.6);
  const doorGeo = merge(doors);
  boxUV(doorGeo, 0.5);
  return [
    { geo: body, mat: lib.painted(0x2f3a44, 0.55) },
    { geo: doorGeo, mat: lib.painted(0x3d4b57, 0.42) },
    { geo: top, mat: lib.concrete('#cfc9bd') },
    { geo: merge(metal), mat: lib.metal('#b9bec5', 0.28, 0.9) },
  ];
}

// --------------------------------------------------------------------------
// Bed
// --------------------------------------------------------------------------
export function bed(lib: MatLib, w = 1.4, l = 2.0): Prop {
  const frameH = 0.28;
  const frame = [
    place(rbox(w, frameH, l, 0.03), 0, frameH / 2 + 0.08, 0),
    place(rbox(w + 0.06, 0.72, 0.09, 0.03), 0, 0.55, -l / 2 - 0.02),        // headboard
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    frame.push(place(box(0.07, 0.08, 0.07), sx * (w / 2 - 0.06), 0.04, sz * (l / 2 - 0.06)));
  }
  const mattress = place(rbox(w - 0.06, 0.24, l - 0.06, 0.07), 0, frameH + 0.2, 0);
  const duvet = [
    place(rbox(w + 0.04, 0.12, l * 0.62, 0.05), 0, frameH + 0.36, l * 0.19),
    place(rbox(w + 0.02, 0.05, 0.16, 0.02), 0, frameH + 0.36, l * 0.19 - l * 0.31),
  ];
  const pillows = [
    place(rbox(w * 0.44, 0.14, 0.34, 0.06), -w * 0.24, frameH + 0.38, -l / 2 + 0.28, -0.12, 0, 0),
    place(rbox(w * 0.44, 0.14, 0.34, 0.06), w * 0.24, frameH + 0.38, -l / 2 + 0.28, -0.12, 0, 0),
  ];
  const frameGeo = merge(frame);
  boxUV(frameGeo, 0.6);
  const mattressGeo = merge([mattress, ...pillows]);
  boxUV(mattressGeo, 0.5);
  const duvetGeo = merge(duvet);
  boxUV(duvetGeo, 0.5);
  return [
    { geo: frameGeo, mat: lib.wood('#8a5f3d') },
    { geo: mattressGeo, mat: lib.fabric('#e6e3dc', 150) },
    { geo: duvetGeo, mat: lib.fabric('#6d7f9c', 90) },
  ];
}

export function rug(lib: MatLib, w = 1.8, d = 1.2, tint = '#8a6f62'): Prop {
  const geo = place(rbox(w, 0.018, d, 0.008), 0, 0.009, 0);
  boxUV(geo, 0.5);
  return [{ geo, mat: lib.carpet(tint), cast: false }];
}

// --------------------------------------------------------------------------
// Plants and lighting
// --------------------------------------------------------------------------
export function potPlant(lib: MatLib, scale = 1): Prop {
  const potH = 0.3 * scale;
  const pot = merge([
    place(cyl(0.17 * scale, 0.13 * scale, potH, 14), 0, potH / 2, 0),
    place(cyl(0.185 * scale, 0.175 * scale, 0.04 * scale, 14), 0, potH - 0.02 * scale, 0),
  ]);
  boxUV(pot, 0.35);
  const soil = place(cyl(0.155 * scale, 0.155 * scale, 0.02, 12), 0, potH - 0.03 * scale, 0);

  // Broad leaves as double-sided planes: four triangles each, and the silhouette
  // is what sells a houseplant.
  const rnd = mulberry32(777);
  const leaves: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rnd() * 0.5;
    const len = (0.34 + rnd() * 0.26) * scale;
    const leaf = new THREE.PlaneGeometry(len * 0.62, len, 1, 2);
    const pos = leaf.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      // Curl the tip down so the leaf is not a flat card.
      const t = (pos.getY(v) + len / 2) / len;
      pos.setZ(v, -t * t * len * 0.32);
      pos.setX(v, pos.getX(v) * (1 - t * 0.55));
    }
    leaf.computeVertexNormals();
    leaf.rotateX(-Math.PI / 2 + 0.5 + rnd() * 0.5);
    leaf.rotateY(a);
    const stemH = potH + (0.18 + rnd() * 0.3) * scale;
    leaves.push(place(leaf, Math.cos(a) * 0.06, stemH + len * 0.42, Math.sin(a) * 0.06));
    const stem = cyl(0.008 * scale, 0.012 * scale, stemH, 5);
    leaves.push(place(stem, Math.cos(a) * 0.03, stemH / 2 + potH * 0.6, Math.sin(a) * 0.03));
  }
  const leafGeo = merge(leaves);
  boxUV(leafGeo, 0.4);
  return [
    { geo: pot, mat: lib.painted(0xb9856a, 0.8) },
    { geo: soil, mat: lib.soil('#3a2e22'), cast: false },
    { geo: leafGeo, mat: lib.foliage(0x3f7a3c), receive: false },
  ];
}

export function floorLamp(lib: MatLib, h = 1.55): Prop {
  const metalParts = [
    place(cyl(0.15, 0.17, 0.03, 14), 0, 0.015, 0),
    place(cyl(0.018, 0.022, h, 8), 0, h / 2, 0),
  ];
  const shade = place(cyl(0.16, 0.24, 0.26, 16, true), 0, h + 0.05, 0);
  boxUV(shade, 0.4);
  const bulb = place(cyl(0.15, 0.15, 0.01, 14), 0, h - 0.06, 0);
  return [
    { geo: merge(metalParts), mat: lib.metal('#3a3f46', 0.5, 0.8) },
    { geo: shade, mat: lib.fabric('#efe3cc', 140) },
    { geo: bulb, mat: lib.emissive(0xffe0b0, 2.4), cast: false },
  ];
}

export function ceilingLamp(lib: MatLib, drop = 0.5): Prop {
  const parts = [
    place(cyl(0.006, 0.006, drop, 6), 0, -drop / 2, 0),
    place(cyl(0.05, 0.05, 0.02, 10), 0, -0.005, 0),
  ];
  const shade = place(cyl(0.09, 0.22, 0.2, 18, true), 0, -drop - 0.1, 0);
  boxUV(shade, 0.4);
  const bulb = place(sph(0.06, 10, 8), 0, -drop - 0.16, 0);
  return [
    { geo: merge(parts), mat: lib.metal('#2e3238', 0.5, 0.8) },
    { geo: shade, mat: lib.painted(0xe8e4dc, 0.6) },
    { geo: bulb, mat: lib.emissive(0xffe8c8, 3.0), cast: false },
  ];
}

/** Wall neon in the shape of a lightning bolt — the `fur_neon_01` catalogue item. */
export function wallNeon(lib: MatLib, tint = 0xff3d9a): Prop {
  const segs: THREE.BufferGeometry[] = [];
  const pts: [number, number][] = [[-0.28, 0.45], [0.02, 0.08], [-0.1, 0.06], [0.24, -0.42]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const tube = cyl(0.022, 0.022, len, 8);
    tube.rotateZ(Math.atan2(y1 - y0, x1 - x0) - Math.PI / 2);
    segs.push(place(tube, (x0 + x1) / 2, (y0 + y1) / 2, 0));
  }
  return [{ geo: merge(segs), mat: lib.emissive(tint, 4.0), cast: false, receive: false }];
}

/** Framed picture; `tint` is the mount colour behind the glass. */
export function wallArt(lib: MatLib, w = 0.7, h = 0.9, tint = 0x8ea9c4): Prop {
  const frame = merge([
    place(box(w, 0.05, 0.04), 0, h / 2 - 0.025, 0),
    place(box(w, 0.05, 0.04), 0, -h / 2 + 0.025, 0),
    place(box(0.05, h - 0.1, 0.04), -w / 2 + 0.025, 0, 0),
    place(box(0.05, h - 0.1, 0.04), w / 2 - 0.025, 0, 0),
  ]);
  boxUV(frame, 0.3);
  const art = place(box(w - 0.1, h - 0.1, 0.02), 0, 0, -0.008);
  return [
    { geo: frame, mat: lib.wood('#6f4a2e'), receive: false },
    { geo: art, mat: lib.painted(tint, 0.65), receive: false },
  ];
}

/**
 * Window: a frame with mullions and a sill, sized to sit inside a wall
 * opening of the same dimensions.
 */
export function windowFrame(lib: MatLib, w: number, h: number, thickness = 0.22): Prop {
  const t = 0.07;
  const parts = [
    place(box(w, t, thickness), 0, h / 2 - t / 2, 0),
    place(box(w, t, thickness), 0, -h / 2 + t / 2, 0),
    place(box(t, h, thickness), -w / 2 + t / 2, 0, 0),
    place(box(t, h, thickness), w / 2 - t / 2, 0, 0),
    place(box(0.05, h - t * 2, thickness * 0.8), 0, 0, 0),
    place(box(w - t * 2, 0.045, thickness * 0.8), 0, h * 0.16, 0),
  ];
  const frame = merge(parts);
  boxUV(frame, 0.4);
  const sill = place(rbox(w + 0.16, 0.05, thickness + 0.14, 0.015), 0, -h / 2 - 0.02, 0.03);
  boxUV(sill, 0.4);
  return [
    { geo: frame, mat: lib.painted(0xe9e6df, 0.5) },
    { geo: sill, mat: lib.concrete('#d5cfc4') },
  ];
}

export function doorFrame(lib: MatLib, w = 0.95, h = 2.1, thickness = 0.24): Prop {
  const t = 0.08;
  const parts = [
    place(box(w + t * 2, t, thickness), 0, h + t / 2, 0),
    place(box(t, h, thickness), -w / 2 - t / 2, h / 2, 0),
    place(box(t, h, thickness), w / 2 + t / 2, h / 2, 0),
  ];
  const frame = merge(parts);
  boxUV(frame, 0.4);
  const leaf = place(rbox(w - 0.02, h - 0.02, 0.05, 0.01), 0, h / 2, 0);
  boxUV(leaf, 0.5);
  const handle = merge([
    place(cyl(0.02, 0.02, 0.07, 8).rotateX(Math.PI / 2), w / 2 - 0.12, 1.02, 0.05),
    place(cyl(0.014, 0.014, 0.1, 8).rotateZ(Math.PI / 2), w / 2 - 0.16, 1.02, 0.09),
  ]);
  return [
    { geo: frame, mat: lib.painted(0xe9e6df, 0.5) },
    { geo: leaf, mat: lib.wood('#9a6b45') },
    { geo: handle, mat: lib.metal('#c2c6cc', 0.3, 0.9) },
  ];
}

/** Streaming setup dressing: mic on a boom, keyboard, mug, small speakers. */
export function deskGear(lib: MatLib): Prop {
  const dark = [
    place(rbox(0.42, 0.015, 0.14, 0.005), -0.05, 0.005, 0.12),               // keyboard
    place(rbox(0.09, 0.012, 0.13, 0.004), 0.24, 0.004, 0.12),                // mouse pad
    place(box(0.09, 0.16, 0.09), -0.52, 0.08, -0.04),                        // speaker L
    place(box(0.09, 0.16, 0.09), 0.52, 0.08, -0.04),                         // speaker R
    place(cyl(0.05, 0.06, 0.02, 12), 0.36, 0.01, -0.16),                     // mic base
    place(cyl(0.012, 0.012, 0.34, 8), 0.36, 0.18, -0.16),
    place(cyl(0.012, 0.012, 0.2, 8).rotateZ(Math.PI / 2.4), 0.28, 0.35, -0.16),
    place(cyl(0.035, 0.03, 0.12, 10), 0.19, 0.33, -0.14, 0.3, 0, 0.3),       // mic body
  ];
  const geo = merge(dark);
  boxUV(geo, 0.3);
  const mug = merge([
    place(cyl(0.04, 0.036, 0.09, 12), -0.42, 0.045, 0.16),
    place(new THREE.TorusGeometry(0.026, 0.008, 5, 10), -0.375, 0.05, 0.16, 0, Math.PI / 2, 0),
  ]);
  return [
    { geo, mat: lib.painted(0x1e2126, 0.6) },
    { geo: mug, mat: lib.painted(0xd8683f, 0.4) },
  ];
}

/** Monitor on a stand; the panel itself is returned as a separate part. */
export function monitor(lib: MatLib, w = 0.62, h = 0.36): Prop {
  const body = merge([
    place(box(w, h, 0.03), 0, h / 2 + 0.16, -0.02),
    place(cyl(0.03, 0.03, 0.16, 8), 0, 0.08, -0.05),
    place(rbox(0.24, 0.02, 0.16, 0.008), 0, 0.01, -0.05),
  ]);
  boxUV(body, 0.3);
  return [{ geo: body, mat: lib.painted(0x1a1d22, 0.45) }];
}

/**
 * A television on a low stand. The panel comes back as its own part so the
 * scene can light it — a dark rectangle on a stand reads as a broken TV.
 */
export function tvSet(lib: MatLib, w = 1.15, h = 0.66): Prop {
  const body = merge([
    place(rbox(w, h, 0.05, 0.012), 0, h / 2 + 0.30, 0),
    place(cyl(0.035, 0.035, 0.22, 8), 0, 0.20, 0),
    place(rbox(w * 0.42, 0.03, 0.24, 0.01), 0, 0.015, 0),
    // Low stand under it: a TV floating at eye height reads as a monitor.
    place(rbox(w * 1.05, 0.28, 0.36, 0.02), 0, -0.001, -0.02),
  ]);
  boxUV(body, 0.35);
  const panel = place(box(w - 0.06, h - 0.06, 0.01), 0, h / 2 + 0.30, 0.031);
  return [
    { geo: body, mat: lib.painted(0x1b1e24, 0.45) },
    { geo: panel, mat: lib.emissive(0x2f6fd8, 1.1) },
  ];
}

/** A desktop tower with a lit side panel — the streamer's status symbol. */
export function pcTower(lib: MatLib): Prop {
  const shell = merge([
    place(rbox(0.22, 0.46, 0.46, 0.012), 0, 0.23, 0),
    place(box(0.02, 0.40, 0.40), 0.111, 0.23, 0),
  ]);
  boxUV(shell, 0.3);
  const lit = merge([
    place(box(0.005, 0.36, 0.36), 0.118, 0.23, 0),
    place(cyl(0.055, 0.055, 0.02, 12).rotateZ(Math.PI / 2), 0.10, 0.32, 0.12),
    place(cyl(0.055, 0.055, 0.02, 12).rotateZ(Math.PI / 2), 0.10, 0.14, 0.12),
  ]);
  return [
    { geo: shell, mat: lib.painted(0x16181d, 0.42, 0.2) },
    { geo: lit, mat: lib.emissive(0x7c5cff, 0.9) },
  ];
}

/** A microphone on a boom arm, clamped to a desk edge. */
export function micBoom(lib: MatLib): Prop {
  const arm = merge([
    place(rbox(0.07, 0.06, 0.09, 0.01), 0, 0.03, 0),
    place(cyl(0.014, 0.014, 0.40, 8), 0, 0.24, 0),
    place(cyl(0.012, 0.012, 0.46, 8).rotateZ(Math.PI / 2.6), 0.16, 0.44, 0),
    place(cyl(0.012, 0.012, 0.30, 8).rotateZ(-Math.PI / 2.2), 0.36, 0.36, 0),
  ]);
  boxUV(arm, 0.25);
  const head = merge([
    place(cyl(0.045, 0.040, 0.16, 12), 0.44, 0.27, 0, Math.PI / 7, 0, 0),
    place(new THREE.TorusGeometry(0.048, 0.006, 5, 14), 0.44, 0.35, 0, Math.PI / 2, 0, 0),
  ]);
  return [
    { geo: arm, mat: lib.painted(0x1a1c21, 0.5) },
    { geo: head, mat: lib.metal('#9aa0a8', 0.35) },
  ];
}

/** An RGB strip: the cheapest thing that makes a room read as "setup". */
export function ledStrip(lib: MatLib, w = 1.6, tint = 0x7c5cff): Prop {
  const rail = place(rbox(w, 0.035, 0.035, 0.008), 0, 0, 0);
  boxUV(rail, 0.3);
  return [
    { geo: rail, mat: lib.painted(0x202329, 0.6) },
    { geo: place(box(w - 0.04, 0.016, 0.006), 0, -0.006, 0.019), mat: lib.emissive(tint, 1.6) },
  ];
}

/** A tall floor plant. Reads at a distance where a pot plant does not. */
export function tallPlant(lib: MatLib, h = 1.35): Prop {
  const rnd = mulberry32(4711);
  const pot = merge([
    place(cyl(0.20, 0.16, 0.30, 14), 0, 0.15, 0),
    place(new THREE.TorusGeometry(0.20, 0.018, 6, 16), 0, 0.29, 0, Math.PI / 2, 0, 0),
  ]);
  boxUV(pot, 0.3);
  const leaves: THREE.BufferGeometry[] = [];
  const stems: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2;
    const t = 0.35 + rnd() * 0.65;
    const y = 0.30 + t * (h - 0.30);
    const reach = (0.10 + rnd() * 0.26) * (0.4 + t);
    stems.push(place(cyl(0.010, 0.008, y - 0.28, 6), Math.cos(a) * reach * 0.3, (y + 0.28) / 2, Math.sin(a) * reach * 0.3));
    // A leaf is a flattened sphere; at this scale the silhouette is all of it.
    const leaf = sph(0.16 + rnd() * 0.08, 8, 6);
    leaf.scale(1, 0.22, 0.6);
    leaves.push(place(leaf, Math.cos(a) * reach, y, Math.sin(a) * reach, rnd() * 0.5 - 0.25, a, rnd() * 0.4 - 0.2));
  }
  return [
    { geo: pot, mat: lib.painted(0xb08363, 0.7) },
    { geo: merge(stems), mat: lib.painted(0x4a6b3a, 0.8) },
    { geo: merge(leaves), mat: lib.painted(0x3f7a45, 0.72) },
  ];
}

/** A stack of books and a mug: the small stuff that says somebody lives here. */
export function trinkets(lib: MatLib, seed = 7): Prop {
  const rnd = mulberry32(seed * 977);
  const books: THREE.BufferGeometry[] = [];
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const t = 0.035 + rnd() * 0.02;
    books.push(place(rbox(0.16 + rnd() * 0.05, t, 0.22, 0.004), (rnd() - 0.5) * 0.03, y + t / 2, (rnd() - 0.5) * 0.03, 0, rnd() * 0.3 - 0.15, 0));
    y += t;
  }
  const stack = merge(books);
  boxUV(stack, 0.3);
  const mug = merge([
    place(cyl(0.042, 0.038, 0.095, 12), 0.20, 0.048, 0.04),
    place(new THREE.TorusGeometry(0.028, 0.008, 5, 10), 0.246, 0.055, 0.04, 0, Math.PI / 2, 0),
  ]);
  return [
    { geo: stack, mat: lib.painted(0x8a5f4a, 0.75) },
    { geo: mug, mat: lib.painted(0xd8683f, 0.4) },
  ];
}
