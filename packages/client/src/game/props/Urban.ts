import * as THREE from 'three';
import { mulberry32 } from '../materials/Noise.js';
import type { MatLib } from './Materials.js';
import {
  box, boxUV, cyl, merge, place, rbox, ringSlab, sph, type Prop,
} from './Geometry.js';

/**
 * Street furniture and greenery for the outdoor scenes.
 *
 * Every builder returns geometry in metres with its origin on the ground at
 * the object's centre, so a prop can be dropped straight onto the pavement
 * with an instance matrix and still cast a contact shadow in the right place.
 * Human scale is the constraint that matters: the avatar is 1.67 m, so a seat
 * is 0.45 m, a handrail 0.95 m and a doorway 2.1 m.
 */

// --------------------------------------------------------------------------
// Bench: 1.8 m of slatted timber on cast-iron legs.
// --------------------------------------------------------------------------
export function bench(lib: MatLib): Prop {
  const L = 1.8;
  const seatH = 0.45;
  const slats: THREE.BufferGeometry[] = [];

  // Seat: five slats with 18 mm gaps, tilted a couple of degrees for comfort.
  for (let i = 0; i < 5; i++) {
    const z = -0.24 + i * 0.115;
    slats.push(place(rbox(L, 0.035, 0.095, 0.014), 0, seatH + z * 0.06, z, -0.06, 0, 0));
  }
  // Back: four slats raked back 12°.
  for (let i = 0; i < 4; i++) {
    const y = seatH + 0.16 + i * 0.125;
    slats.push(place(rbox(L, 0.035, 0.1, 0.014), 0, y, -0.3 - i * 0.027, Math.PI / 2 - 0.21, 0, 0));
  }

  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const x = sx * (L / 2 - 0.16);
    // Side frame: foot, upright and the arm that carries the backrest.
    legs.push(place(box(0.05, seatH, 0.06), x, seatH / 2, 0.22));
    legs.push(place(box(0.05, seatH, 0.06), x, seatH / 2, -0.24));
    legs.push(place(box(0.06, 0.05, 0.62), x, 0.025, -0.02));
    legs.push(place(box(0.045, 0.62, 0.05), x, seatH + 0.24, -0.36, -0.21, 0, 0));
    legs.push(place(box(0.05, 0.045, 0.5), x, seatH + 0.4, -0.12));
  }

  const wood = merge(slats);
  const iron = merge(legs);
  boxUV(wood, 0.5);
  boxUV(iron, 0.4);
  return [
    { geo: wood, mat: lib.wood('#8a5c3a') },
    { geo: iron, mat: lib.metal('#3a3d42', 0.55, 0.7) },
  ];
}

// --------------------------------------------------------------------------
// Lamp post: 4.4 m column with a downward luminaire and a banner arm.
// --------------------------------------------------------------------------
export function lampPost(lib: MatLib, height = 4.4): Prop {
  const steel: THREE.BufferGeometry[] = [];
  steel.push(place(cyl(0.11, 0.15, 0.22, 12), 0, 0.11, 0));
  steel.push(place(cyl(0.055, 0.085, height - 0.22, 12), 0, 0.11 + (height - 0.22) / 2, 0));
  // Curved head: three short segments approximating a shepherd's crook.
  steel.push(place(cyl(0.05, 0.055, 0.42, 10), 0.1, height + 0.06, 0, 0, 0, -0.5));
  steel.push(place(cyl(0.045, 0.05, 0.34, 10), 0.36, height + 0.16, 0, 0, 0, -1.25));
  steel.push(place(cyl(0.16, 0.09, 0.16, 12), 0.5, height + 0.06, 0));

  const glassGeo = place(cyl(0.14, 0.1, 0.05, 12), 0.5, height - 0.02, 0);

  const body = merge(steel);
  boxUV(body, 0.6);
  return [
    { geo: body, mat: lib.metal('#2e3238', 0.5, 0.8) },
    { geo: glassGeo, mat: lib.emissive(0xffd9a0, 3.2), cast: false },
  ];
}

// --------------------------------------------------------------------------
// Trees: stylised low-poly canopies on a tapered trunk.
// --------------------------------------------------------------------------
export function tree(lib: MatLib, variant = 0): Prop {
  const rnd = mulberry32(9001 + variant * 7717);
  const trunkH = 2.3 + rnd() * 0.6;
  const wood: THREE.BufferGeometry[] = [];
  wood.push(place(cyl(0.11, 0.24, trunkH, 9), 0, trunkH / 2, 0));
  // Root flare stops the trunk from reading as a pipe stuck in the ground.
  wood.push(place(cyl(0.22, 0.4, 0.28, 9), 0, 0.14, 0));

  const branches = 3 + (variant % 2);
  const blobs: THREE.BufferGeometry[] = [];
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rnd() * 0.8;
    const len = 0.9 + rnd() * 0.5;
    const tilt = 0.5 + rnd() * 0.25;
    const bx = Math.cos(a) * len * 0.6;
    const bz = Math.sin(a) * len * 0.6;
    const by = trunkH + len * 0.5;
    const seg = cyl(0.045, 0.09, len, 6);
    seg.rotateZ(-Math.cos(a) * tilt);
    seg.rotateX(Math.sin(a) * tilt);
    wood.push(place(seg, bx * 0.5, trunkH + len * 0.28, bz * 0.5));

    const blob = new THREE.IcosahedronGeometry(0.85 + rnd() * 0.45, 1);
    blob.scale(1.15, 0.82, 1.15);
    blobs.push(place(blob, bx, by + rnd() * 0.3, bz));
  }
  const crown = new THREE.IcosahedronGeometry(1.25, 1);
  crown.scale(1.2, 0.9, 1.2);
  blobs.push(place(crown, 0, trunkH + 1.35, 0));

  const trunk = merge(wood);
  boxUV(trunk, 0.7);
  const canopy = merge(blobs);
  boxUV(canopy, 1.6);
  return [
    { geo: trunk, mat: lib.wood('#6b4a33') },
    { geo: canopy, mat: lib.foliage(variant % 2 ? 0x4a7534 : 0x5b8a3f), receive: false },
  ];
}

/** Clipped ornamental shrub for planters. */
export function shrub(lib: MatLib, r = 0.55): Prop {
  const blobs: THREE.BufferGeometry[] = [];
  const rnd = mulberry32(4242);
  for (let i = 0; i < 3; i++) {
    const g = new THREE.IcosahedronGeometry(r * (0.7 + rnd() * 0.4), 1);
    g.scale(1.1, 0.85, 1.1);
    blobs.push(place(g, (rnd() - 0.5) * r, r * 0.6 + rnd() * r * 0.3, (rnd() - 0.5) * r));
  }
  const geo = merge(blobs);
  boxUV(geo, 1.2);
  return [{ geo, mat: lib.foliage(0x53803c), receive: false }];
}

// --------------------------------------------------------------------------
// Planter: a stone box holding soil and a shrub.
// --------------------------------------------------------------------------
export function planter(lib: MatLib, w = 1.5, d = 1.5, h = 0.5): Prop {
  const t = 0.12;
  const walls = [
    place(box(w, h, t), 0, h / 2, d / 2 - t / 2),
    place(box(w, h, t), 0, h / 2, -d / 2 + t / 2),
    place(box(t, h, d - t * 2), w / 2 - t / 2, h / 2, 0),
    place(box(t, h, d - t * 2), -w / 2 + t / 2, h / 2, 0),
  ];
  // Coping stones read as a separate course and catch the sun on top.
  walls.push(place(rbox(w + 0.06, 0.06, d + 0.06, 0.02), 0, h + 0.03, 0));
  const stone = merge(walls);
  boxUV(stone, 0.6);
  const soil = place(box(w - t * 2, 0.06, d - t * 2), 0, h - 0.09, 0);
  boxUV(soil, 0.5);
  return [
    { geo: stone, mat: lib.concrete('#a49b8d') },
    { geo: soil, mat: lib.soil(), cast: false },
  ];
}

// --------------------------------------------------------------------------
// Small fixtures.
// --------------------------------------------------------------------------
export function bollard(lib: MatLib): Prop {
  const parts = [
    place(cyl(0.09, 0.12, 0.86, 10), 0, 0.43, 0),
    place(sph(0.095, 10, 6), 0, 0.86, 0),
    place(cyl(0.13, 0.14, 0.05, 10), 0, 0.025, 0),
  ];
  const geo = merge(parts);
  boxUV(geo, 0.4);
  return [{ geo, mat: lib.metal('#33373d', 0.5, 0.75) }];
}

export function litterBin(lib: MatLib): Prop {
  const body = merge([
    place(cyl(0.24, 0.2, 0.78, 12, true), 0, 0.44, 0),
    place(cyl(0.26, 0.26, 0.04, 12), 0, 0.87, 0),
    place(cyl(0.2, 0.2, 0.05, 12), 0, 0.05, 0),
  ]);
  boxUV(body, 0.5);
  const liner = place(cyl(0.19, 0.19, 0.02, 10), 0, 0.8, 0);
  return [
    { geo: body, mat: lib.metal('#3f4750', 0.6, 0.6) },
    { geo: liner, mat: lib.painted(0x14171b, 0.9), cast: false },
  ];
}

/**
 * Two-step round fountain. Water is a separate part so the scene can animate
 * its normal offset without touching the stone.
 */
export function fountain(lib: MatLib, r = 3.2): Prop {
  const stone: THREE.BufferGeometry[] = [];
  stone.push(place(ringSlab(r - 0.5, r, 0.42, 40), 0, 0, 0));
  stone.push(place(ringSlab(r - 0.62, r + 0.12, 0.1, 40), 0, 0.42, 0));
  stone.push(place(cyl(0.55, 0.75, 0.95, 16), 0, 0.48, 0));
  stone.push(place(cyl(0.9, 0.5, 0.14, 20), 0, 1.02, 0));
  stone.push(place(cyl(0.1, 0.16, 0.55, 12), 0, 1.32, 0));
  stone.push(place(sph(0.17, 12, 8), 0, 1.66, 0));
  const body = merge(stone);
  boxUV(body, 0.8);

  const water = merge([
    place(new THREE.CircleGeometry(r - 0.52, 40).rotateX(-Math.PI / 2), 0, 0.3, 0),
    place(new THREE.CircleGeometry(0.86, 24).rotateX(-Math.PI / 2), 0, 1.08, 0),
  ]);
  boxUV(water, 2.0);
  return [
    { geo: body, mat: lib.concrete('#b0a89a') },
    { geo: water, mat: lib.water(), cast: false },
  ];
}

/**
 * Market kiosk with an awning — the plaza needs at least one object at
 * shopfront scale to sell the idea that the square is used.
 */
export function kiosk(lib: MatLib, w = 3.0, d = 2.4): Prop {
  const h = 2.75;
  const shell = [
    place(box(w, h, 0.12), 0, h / 2, -d / 2),
    place(box(0.12, h, d), -w / 2, h / 2, 0),
    place(box(0.12, h, d), w / 2, h / 2, 0),
    place(box(w, 0.95, 0.12), 0, 0.475, d / 2),      // counter front
    place(box(w, 0.6, 0.12), 0, h - 0.3, d / 2),      // header above the opening
  ];
  const roof = [
    place(rbox(w + 0.36, 0.16, d + 0.36, 0.05), 0, h + 0.08, 0),
    place(box(w + 0.2, 0.06, 0.5), 0, h + 0.02, d / 2 + 0.42),
  ];
  const counter = place(rbox(w + 0.12, 0.07, 0.5, 0.02), 0, 0.98, d / 2 + 0.06);
  // Awning: a thin slab raked forward off the header.
  const awning = place(box(w + 0.3, 0.04, 1.25), 0, h - 0.02, d / 2 + 0.58, -0.26, 0, 0);

  const bodyGeo = merge(shell);
  boxUV(bodyGeo, 0.9);
  const roofGeo = merge(roof);
  boxUV(roofGeo, 0.8);
  boxUV(counter, 0.6);
  boxUV(awning, 0.55);
  return [
    { geo: bodyGeo, mat: lib.plaster('#d9cfbe') },
    { geo: roofGeo, mat: lib.metal('#4b5158', 0.6, 0.7) },
    { geo: counter, mat: lib.wood('#9a6a44') },
    { geo: awning, mat: lib.fabric('#b8464a', 60) },
  ];
}

/** Vertical banner hanging from a lamp arm. */
export function banner(lib: MatLib, w = 0.62, h = 1.9, tint = '#2f6fb8'): Prop {
  const cloth = place(box(w, h, 0.02), 0, -h / 2, 0);
  boxUV(cloth, 0.9);
  const rod = merge([
    place(cyl(0.015, 0.015, w + 0.08, 6).rotateZ(Math.PI / 2), 0, 0.01, 0),
    place(cyl(0.015, 0.015, w + 0.08, 6).rotateZ(Math.PI / 2), 0, -h - 0.01, 0),
  ]);
  return [
    { geo: cloth, mat: lib.fabric(tint, 80), receive: false },
    { geo: rod, mat: lib.metal('#2e3238', 0.5, 0.8), receive: false },
  ];
}

/** Low stair block: `steps` treads of 0.35 m at 0.15 m rise. */
export function stairRing(
  lib: MatLib, innerR: number, steps = 3, rise = 0.15, tread = 0.42,
): Prop {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const r = innerR + (steps - i) * tread;
    parts.push(place(ringSlab(r - tread - 0.001, r, rise + 0.001, 56), 0, i * rise, 0));
  }
  const geo = merge(parts);
  boxUV(geo, 0.9);
  return [{ geo, mat: lib.concrete('#a8a196') }];
}

/**
 * A palm. The plaza had three canopy variants and all three were the same
 * round tree — a skyline of identical lollipops reads as a placeholder however
 * good the lighting is.
 */
export function palm(lib: MatLib, seed = 3): Prop {
  const rnd = mulberry32(6100 + seed * 331);
  const h = 3.4 + rnd() * 1.4;
  const trunk: THREE.BufferGeometry[] = [];
  const segs = 7;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    // A palm leans; a vertical pole reads as a mast.
    const lean = Math.sin(t * 1.3) * 0.55;
    trunk.push(place(
      cyl(0.16 - t * 0.06, 0.19 - t * 0.06, h / segs + 0.04, 8),
      lean, h * t + h / segs / 2, 0,
      0, 0, Math.sin(t * 1.3) * 0.12,
    ));
  }
  const fronds: THREE.BufferGeometry[] = [];
  const top = new THREE.Vector3(Math.sin(1.3) * 0.55, h, 0);
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rnd() * 0.3;
    const droop = 0.5 + rnd() * 0.4;
    const leaf = box(2.1, 0.05, 0.42);
    leaf.translate(1.05, 0, 0);
    fronds.push(place(leaf, top.x, top.y, top.z, 0, -a, -droop));
  }
  return [
    { geo: merge(trunk), mat: lib.painted(0x8a6f4e, 0.85) },
    { geo: merge(fronds), mat: lib.painted(0x4f8a46, 0.78) },
  ];
}

/** A shrub in bloom. The flowers are the only saturated thing about it. */
export function flowerBush(lib: MatLib, r = 0.55, bloom = 0xd8567a): Prop {
  const leaves: THREE.BufferGeometry[] = [];
  const buds: THREE.BufferGeometry[] = [];
  const rnd = mulberry32(8123);
  for (let i = 0; i < 3; i++) {
    const s = r * (0.7 + rnd() * 0.5);
    leaves.push(place(sph(s, 7, 6), (rnd() - 0.5) * r, s * 0.75, (rnd() - 0.5) * r));
  }
  for (let i = 0; i < 14; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = r * (0.5 + rnd() * 0.55);
    buds.push(place(sph(0.055 + rnd() * 0.03, 5, 4), Math.cos(a) * rr, r * (0.6 + rnd() * 0.7), Math.sin(a) * rr));
  }
  return [
    { geo: merge(leaves), mat: lib.painted(0x3f7a45, 0.8) },
    { geo: merge(buds), mat: lib.painted(bloom, 0.62) },
  ];
}

/**
 * A striped awning over a kiosk or a shopfront. Cloth at head height is what
 * turns a row of façades into a street; stone alone reads as a monument.
 */
export function awning(lib: MatLib, w = 2.6, drop = 0.9, tint = 0xc2542f): Prop {
  const slope = place(box(w, 0.06, drop * 1.25), 0, 0.30, drop * 0.5, -0.42, 0, 0);
  boxUV(slope, 0.6);
  const valance = place(box(w, 0.22, 0.05), 0, -0.02, drop * 0.92);
  const bars = merge([
    place(cyl(0.03, 0.03, w, 8).rotateZ(Math.PI / 2), 0, 0.52, 0),
    place(cyl(0.022, 0.022, 0.9, 6), -w / 2 + 0.1, 0.25, drop * 0.45, 0.5, 0, 0),
    place(cyl(0.022, 0.022, 0.9, 6), w / 2 - 0.1, 0.25, drop * 0.45, 0.5, 0, 0),
  ]);
  return [
    { geo: merge([slope, valance]), mat: lib.painted(tint, 0.86) },
    { geo: bars, mat: lib.metal('#9aa0a8', 0.45) },
  ];
}
