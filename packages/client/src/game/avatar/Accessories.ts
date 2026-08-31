import * as THREE from 'three';
import { loft, assemble, type Station } from './Loft.js';
import type { BuiltRig } from './Skeleton.js';
import {
  type BodyShape, type FaceShape, FACE_PRESETS,
  skullPoint, headRadius, headCentre, torso,
} from './BodyBuilder.js';
import { makeClothMaterial } from './Materials.js';
import type { Builder } from './Wardrobe.js';

/**
 * Accessories.
 *
 * The catalogue has been selling glasses, a cap, a headset and a halo since
 * the shop shipped, and none of them had any geometry behind them — you could
 * buy one and wear nothing. This is that geometry.
 *
 * Everything that touches the head is placed through `skullPoint`, so a cap
 * band follows the same skull the hair does and a preset with a wider jaw does
 * not push its own glasses off its face. Everything else hangs off the torso
 * profile, for the same reason garments do.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface HeadContext {
  rig: BuiltRig;
  R: number;
  face: FaceShape;
  /** Head-bone rest position; head-local geometry is lifted by this. */
  originY: number;
  originZ: number;
}

function headContext(rig: BuiltRig, shape: BodyShape): HeadContext {
  // The face preset drives head size, and an accessory is fitted to the head
  // it is worn on. BodyShape carries no face index, so the rig's own
  // proportions are the honest source: presets share the index.
  const face = FACE_PRESETS[0];
  void shape;
  const R = headRadius(rig, face);
  const c = headCentre(rig, face);
  return { rig, R, face, originY: rig.restWorld.Head.y + c.y, originZ: c.z };
}

/** Lifts head-local geometry into rest world space. */
function onHead(ctx: HeadContext, geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.translate(0, ctx.originY, ctx.originZ);
  return geo;
}

/** A tube through a run of directions on the skull, lifted off it. */
function band(
  ctx: HeadContext,
  dirs: Array<[number, number, number]>,
  radii: Array<[number, number]>,
  lifts: number[],
): Station[] {
  return dirs.map((d, i) => ({
    pos: skullPoint(V(d[0], d[1], d[2]), ctx.R, ctx.face, lifts[i]),
    radiusX: radii[i][0] * ctx.R,
    radiusZ: radii[i][1] * ctx.R,
    bone: 'Head' as const,
    squareness: 2.3,
  }));
}

const weld = (parts: ReturnType<typeof loft>[]) => assemble(parts);

const tube = (st: Station[], segments = 10, cap = true) =>
  loft(st, { segments, capStart: cap, capEnd: cap, capRound: 0.8, subdivisions: 2 });

// --------------------------------------------------------------------------
// Eyewear
// --------------------------------------------------------------------------

/**
 * Glasses. The lens rims are rings swept around the eye, the bridge crosses
 * the nose and the temples run back to the ear — three parts, because a single
 * ring floating in front of a face reads as a decal.
 */
function eyewear(ctx: HeadContext, opts: { lens: number; thick: number; wrap: number }) {
  const { R, face } = ctx;
  const parts: ReturnType<typeof loft>[] = [];
  const frames: ReturnType<typeof loft>[] = [];

  for (const side of [-1, 1]) {
    const centre = skullPoint(V(side * 0.34, -0.055, 0.92), R, face, 0.026);
    // Rim: a closed ring in the plane of the face, tilted to follow the cheek.
    const rim: Station[] = [];
    const steps = 18;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      rim.push({
        pos: centre.clone().add(V(
          Math.cos(a) * opts.lens * R,
          Math.sin(a) * opts.lens * R * 0.62,
          -Math.abs(Math.cos(a)) * opts.wrap * R,
        )),
        radiusX: opts.thick * R,
        radiusZ: opts.thick * R,
        bone: 'Head',
      });
    }
    frames.push(loft(rim, { segments: 6, capStart: false, capEnd: false, subdivisions: 1 }));

    // Temple: from the rim's outer edge back to just above the ear.
    frames.push(tube(band(ctx,
      [[side * 0.62, -0.03, 0.72], [side * 0.92, 0.01, 0.20], [side * 0.96, 0.0, -0.30]],
      [[opts.thick, opts.thick], [opts.thick, opts.thick], [opts.thick * 0.8, opts.thick * 0.8]],
      [0.035, 0.022, 0.012],
    ), 6));
  }

  // Bridge across the nose.
  frames.push(tube(band(ctx,
    [[-0.13, -0.01, 0.98], [0, 0.01, 1.0], [0.13, -0.01, 0.98]],
    [[opts.thick, opts.thick], [opts.thick, opts.thick], [opts.thick, opts.thick]],
    [0.03, 0.026, 0.03],
  ), 6));

  parts.push(...frames);
  return parts;
}

// --------------------------------------------------------------------------
// Headwear
// --------------------------------------------------------------------------

/** A dome that hugs the skull between two heights, plus an optional brim. */
function domeCap(ctx: HeadContext, opts: { from: number; to: number; lift: number; rings?: number }) {
  const { R, face } = ctx;
  const st: Station[] = [];
  const rings = opts.rings ?? 7;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const y = THREE.MathUtils.lerp(opts.from, opts.to, t);
    const r = Math.sqrt(Math.max(0.0025, 1 - y * y));
    // Sampled on the skull at four compass points and averaged, so the cap
    // follows a sculpted head instead of assuming a sphere.
    const probe = [V(r, y, 0), V(-r, y, 0), V(0, y, r), V(0, y, -r)]
      .map((d) => skullPoint(d, R, face, opts.lift));
    const cx = (probe[0].x - probe[1].x) / 2;
    const cz = (probe[2].z - probe[3].z) / 2;
    st.push({
      pos: V(0, probe[0].y, (probe[2].z + probe[3].z) / 2),
      radiusX: Math.max(0.004, cx),
      radiusZ: Math.max(0.004, cz),
      bone: 'Head',
      squareness: 2.1,
    });
  }
  return st;
}

/**
 * A cap brim: a flat shelf swept FORWARD from the band.
 *
 * The first version swept a ring sideways across the head with a roll, and the
 * loft turned that into a wing sticking off one ear. A brim runs along +Z; the
 * cross-section perpendicular to that path is exactly what a brim is — wide in
 * X, thin in Y.
 */
function brim(ctx: HeadContext, opts: { y: number; reach: number; thick: number; span: number }): Station[] {
  const { R, face } = ctx;
  const root = skullPoint(V(0, opts.y, 1), R, face, 0.012);
  const st: Station[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    st.push({
      pos: V(0, root.y - t * t * 0.14 * R, root.z + t * opts.reach * R),
      // Widest just past the band, tapering to a rounded tip.
      radiusX: opts.span * R * (0.72 + Math.sin(t * Math.PI * 0.9) * 0.28) * (1 - t * 0.22),
      radiusZ: opts.thick * R,
      bone: 'Head',
      squareness: 3.2,
    });
  }
  return st;
}

// --------------------------------------------------------------------------
// Neckwear — hangs off the torso, not the skull
// --------------------------------------------------------------------------

/**
 * A ring around the neck that SAGS at the front, following the chest it falls
 * onto rather than the neck it hangs from.
 *
 * Sizing the whole ring from the neck was why the chain shipped invisible: the
 * front of it dips to mid-chest, where the trunk is 7 cm wider, so the pendant
 * end sat inside the ribcage.
 */
function neckRing(rig: BuiltRig, shape: BodyShape, dy: number, thick: number, sag: number): Station[] {
  const rw = rig.restWorld;
  const trunk = torso(rig, shape);
  const atHeight = (y: number) => trunk.reduce((best, st) =>
    Math.abs(st.pos.y - y) < Math.abs(best.pos.y - y) ? st : best);

  // Clearance for whatever top is underneath. A ring sized to the BODY sits
  // inside every garment in the catalogue.
  const overGarment = 0.034;
  const top = rw.Neck.y + dy;

  const st: Station[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const front = Math.max(0, Math.cos(a));
    const y = top - front * front * sag;
    const here = atHeight(y);
    const rx = here.radiusX + overGarment + thick * 0.5;
    const rz = here.radiusZ + overGarment + thick * 0.5;
    st.push({
      pos: V(Math.sin(a) * rx, y, here.pos.z + Math.cos(a) * rz),
      radiusX: thick * 0.5,
      radiusZ: thick * 0.5,
      bone: y > rw.Spine2.y + 0.06 ? 'Neck' : 'Spine2',
      blendBone: 'Spine2',
      blendWeight: 0.45,
    });
  }
  return st;
}

// --------------------------------------------------------------------------
// Catalogue
// --------------------------------------------------------------------------

const metal = (color: string, rough = 0.28) =>
  makeClothMaterial({ color, roughness: rough, metalness: 0.75, sheen: 0.4 });

const fabric = (color: string, rough = 0.86) =>
  makeClothMaterial({ color, roughness: rough, sheen: 0.25 });

export const ACCESSORY_BUILDERS: Record<string, Builder> = {
  acc_glasses_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    return {
      geometry: onHead(ctx, weld(eyewear(ctx, { lens: 0.24, thick: 0.014, wrap: 0.06 }))),
      material: makeClothMaterial({ color, roughness: 0.3, metalness: 0.35, sheen: 0.5 }),
    };
  },

  acc_shades_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    const frame = eyewear(ctx, { lens: 0.26, thick: 0.018, wrap: 0.08 });
    // Lenses: shallow shells filling each rim, dark and glossy.
    const lenses: ReturnType<typeof loft>[] = [];
    for (const side of [-1, 1]) {
      lenses.push(tube(band(ctx,
        [[side * 0.34, -0.055, 0.94], [side * 0.34, -0.055, 0.90]],
        [[0.245, 0.152], [0.245, 0.152]],
        [0.024, 0.012],
      ), 18, true));
    }
    return [
      { geometry: onHead(ctx, weld(frame)), material: metal('#1a1c22', 0.35) },
      {
        geometry: onHead(headContext(rig, shape), weld(lenses)),
        material: makeClothMaterial({ color, roughness: 0.08, metalness: 0.2, sheen: 0.9 }),
      },
    ];
  },

  acc_cap_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    return [
      {
        geometry: onHead(ctx, weld([
          tube(domeCap(ctx, { from: 0.26, to: 0.96, lift: 0.02 }), 20, false),
        ])),
        material: fabric(color, 0.82),
      },
      {
        geometry: onHead(headContext(rig, shape), weld([
          loft(brim(ctx, { y: 0.28, reach: 0.72, thick: 0.022, span: 0.52 }),
            { segments: 12, capStart: true, capEnd: true, capRound: 0.3, subdivisions: 2 }),
        ])),
        material: fabric(color, 0.7),
      },
    ];
  },

  acc_beanie_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    return [
      {
        geometry: onHead(ctx, weld([tube(domeCap(ctx, { from: 0.06, to: 1.0, lift: 0.035 }), 20, false)])),
        material: fabric(color, 0.94),
      },
      {
        // The turned-up brim, which is the whole silhouette of a beanie.
        geometry: onHead(headContext(rig, shape), weld([
          tube(domeCap(ctx, { from: 0.05, to: 0.26, lift: 0.055 }), 20, false),
        ])),
        material: fabric(color, 0.9),
      },
    ];
  },

  acc_headset_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    const parts: ReturnType<typeof loft>[] = [];
    // Headband over the crown.
    const arc: Station[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = THREE.MathUtils.lerp(-Math.PI / 2, Math.PI / 2, i / 10);
      arc.push({
        pos: skullPoint(V(Math.sin(a), Math.cos(a) * 0.95, -0.10), ctx.R, ctx.face, 0.045),
        radiusX: 0.050 * ctx.R,
        radiusZ: 0.032 * ctx.R,
        bone: 'Head',
        squareness: 2.6,
      });
    }
    parts.push(tube(arc, 8));
    // Ear cups.
    for (const side of [-1, 1]) {
      parts.push(tube(band(ctx,
        [[side * 1.0, -0.04, -0.30], [side * 1.0, -0.04, -0.30]],
        [[0.26, 0.24], [0.22, 0.20]],
        [0.015, 0.135],
      ), 16));
    }
    // Boom mic, the detail that says "stream" rather than "music".
    parts.push(tube(band(ctx,
      [[-1.0, -0.05, -0.28], [-0.92, -0.30, 0.20], [-0.62, -0.40, 0.62]],
      [[0.028, 0.028], [0.024, 0.024], [0.038, 0.038]],
      [0.10, 0.10, 0.09],
    ), 8));
    return { geometry: onHead(ctx, weld(parts)), material: metal(color, 0.42) };
  },

  acc_earrings_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    const parts: ReturnType<typeof loft>[] = [];
    for (const side of [-1, 1]) {
      const lobe = skullPoint(V(side, -0.34, -0.30), ctx.R, ctx.face, 0.02);
      const ring: Station[] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ring.push({
          pos: lobe.clone().add(V(side * 0.02 * ctx.R, -0.15 * ctx.R + Math.cos(a) * 0.145 * ctx.R, Math.sin(a) * 0.145 * ctx.R)),
          radiusX: 0.026 * ctx.R,
          radiusZ: 0.026 * ctx.R,
          bone: 'Head',
        });
      }
      parts.push(loft(ring, { segments: 6, capStart: false, capEnd: false, subdivisions: 1 }));
    }
    return { geometry: onHead(ctx, weld(parts)), material: metal(color, 0.18) };
  },

  acc_chain_01: (rig, shape, color) => ({
    geometry: assemble([loft(neckRing(rig, shape, -0.02, 0.026, 0.24),
      { segments: 6, capStart: false, capEnd: false, subdivisions: 2 })]),
    material: metal(color, 0.16),
  }),

  acc_scarf_01: (rig, shape, color) => {
    const parts = [loft(neckRing(rig, shape, 0.0, 0.075, 0.06),
      { segments: 12, capStart: false, capEnd: false, subdivisions: 2 })];
    // One loose end hanging down the chest.
    const rw = rig.restWorld;
    const tailSt: Station[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      tailSt.push({
        pos: V(0.055, rw.Neck.y - 0.02 - t * 0.34, rw.Spine2.z + 0.115 - t * 0.02),
        radiusX: 0.052 * (1 - t * 0.25),
        radiusZ: 0.022,
        bone: 'Spine2',
        blendBone: 'Spine1',
        blendWeight: Math.min(0.4, t * 0.6),
        squareness: 3.0,
      });
    }
    parts.push(loft(tailSt, { segments: 8, capStart: true, capEnd: true, capRound: 0.3, subdivisions: 2 }));
    return { geometry: assemble(parts), material: fabric(color, 0.95) };
  },

  acc_mask_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    // Covers nose and mouth, hooked back toward the ears.
    const st = band(ctx,
      [[-0.98, -0.24, -0.10], [-0.55, -0.30, 0.66], [0, -0.34, 0.98], [0.55, -0.30, 0.66], [0.98, -0.24, -0.10]],
      [[0.10, 0.05], [0.20, 0.09], [0.22, 0.10], [0.20, 0.09], [0.10, 0.05]],
      [0.01, 0.035, 0.045, 0.035, 0.01],
    ).map((s) => ({ ...s, roll: Math.PI / 2, squareness: 2.6 }));
    return {
      geometry: onHead(ctx, weld([tube(st, 10, false)])),
      material: fabric(color, 0.88),
    };
  },

  acc_halo_01: (rig, shape, color) => {
    const ctx = headContext(rig, shape);
    const ring: Station[] = [];
    const r = 0.62 * ctx.R;
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      ring.push({
        pos: V(Math.cos(a) * r, 1.30 * ctx.R, ctx.R * 0.06 + Math.sin(a) * r),
        radiusX: 0.045 * ctx.R,
        radiusZ: 0.045 * ctx.R,
        bone: 'Head',
      });
    }
    return {
      geometry: onHead(ctx, assemble([loft(ring, { segments: 8, capStart: false, capEnd: false, subdivisions: 1 })])),
      material: makeClothMaterial({
        color, roughness: 0.2, metalness: 0.4, sheen: 0.9,
        emissive: color, emissiveIntensity: 2.2,
      }),
    };
  },
};

export const ACCESSORY_IDS = Object.keys(ACCESSORY_BUILDERS);
