import * as THREE from 'three';
import { loft, assemble, mergeGeometries, type Station } from './Loft.js';
import { BONE_INDEX, type BuiltRig } from './Skeleton.js';
import { type FaceShape, skullPoint, headRadius, headCentre } from './BodyBuilder.js';
import { makeHairMaterial } from './Materials.js';

/**
 * Hair System v2.
 *
 * The old hair was one shell offset from a plain sphere. Two things were wrong
 * with that and both were fatal: the shell ignored the head sculpt, so it slid
 * off the skull the moment a face preset reshaped it, and a single shell has
 * no strands — it reads as a swim cap however it is carved.
 *
 * A style here is built from five parts, which is how hair actually reads at
 * this scale:
 *
 *   base     the scalp cap, laid ON the sculpted skull;
 *   locks    main strands with real thickness, sitting proud of the base;
 *   fringe   what falls over the forehead;
 *   sides    what frames the face;
 *   back     the volume behind, which is most of the silhouette.
 *
 * All of it merges into ONE geometry, so a style with thirty strands still
 * costs one draw call. Hair is the most-bought item in the genre and the one
 * this project was weakest at, so it is worth the file.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const smooth = (e0: number, e1: number, x: number) => THREE.MathUtils.smoothstep(x, e0, e1);

/**
 * Scalp coverage at a direction: 1 where the style has full hair, 0 on bare
 * skin. Normalised rather than absolute so the cap can decide, from coverage
 * alone, where to tuck itself under the skin.
 */
type CapMask = (n: THREE.Vector3) => number;

interface StyleContext {
  R: number;
  face: FaceShape;
}

interface HairStyle {
  base: CapMask;
  /** Cap thickness in head radii where coverage is 1. */
  thickness: number;
  /** Everything that is not the cap: locks, fringe, sides, back volume. */
  locks?: (ctx: StyleContext) => Station[][];
}

// --------------------------------------------------------------------------
// Strand builders
// --------------------------------------------------------------------------

/**
 * A lock of hair. It starts on the scalp at `from`, leaves along `sweep`, and
 * tapers over `length`. `sag` bends it downward as it goes, which is the whole
 * difference between hair and a set of horns.
 */
function lock(
  ctx: StyleContext,
  from: THREE.Vector3,
  sweep: THREE.Vector3,
  opts: { length: number; thick: number; sag?: number; taper?: number; wave?: number; steps?: number },
): Station[] {
  const { R, face } = ctx;
  const root = skullPoint(from, R, face, 0.012);
  const dir = sweep.clone().normalize();
  const steps = opts.steps ?? 5;
  const sag = opts.sag ?? 0.6;
  const taper = opts.taper ?? 0.35;
  const wave = opts.wave ?? 0;
  const side = new THREE.Vector3().crossVectors(dir, V(0, 1, 0)).normalize();

  const out: Station[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = root.clone()
      .addScaledVector(dir, opts.length * R * t)
      // Gravity accumulates with the square of the distance travelled, which
      // is what makes a lock curve instead of sticking out straight.
      .addScaledVector(V(0, -1, 0), opts.length * R * sag * t * t)
      .addScaledVector(side, Math.sin(t * Math.PI * 2) * wave * R);
    out.push({
      pos: p,
      radiusX: opts.thick * R * (1 - taper * t),
      radiusZ: opts.thick * R * 0.78 * (1 - taper * t),
      bone: 'Head',
      squareness: 2.4,
    });
  }
  return out;
}

/** A row of locks fanned across an arc of the hairline. */
function fan(
  ctx: StyleContext,
  count: number,
  arc: { fromX: number; toX: number; y: number; z: number },
  sweep: (u: number) => THREE.Vector3,
  opts: { length: number; thick: number; sag?: number; wave?: number; jitter?: number },
): Station[][] {
  const out: Station[][] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0.5 : i / (count - 1);
    const x = THREE.MathUtils.lerp(arc.fromX, arc.toX, u);
    // A little irregularity: perfectly even strands read as a wig stand.
    const j = opts.jitter ? Math.sin(i * 12.9898) * opts.jitter : 0;
    out.push(lock(ctx, V(x, arc.y + j, arc.z), sweep(u), {
      length: opts.length * (1 + j * 1.5),
      thick: opts.thick,
      sag: opts.sag,
      wave: opts.wave,
    }));
  }
  return out;
}

/**
 * A draped strand: it follows the skull down while there is skull to follow,
 * then falls free of it.
 *
 * The obvious version — start on the scalp and drop straight down — buries the
 * whole strand inside the head, because the skull keeps widening below the
 * crown. That is why the first back volume was invisible from behind: it was
 * all in there.
 *
 * `length` is arc length in head radii, so a bob and a waist-length style are
 * quoted in the same unit.
 */
function drape(
  ctx: StyleContext,
  opts: {
    /** Horizontal direction the strand hangs on; need not be normalised. */
    dir: THREE.Vector3;
    /** Height on the unit sphere where it leaves the crown, -1..1. */
    startY: number;
    length: number;
    thick: number;
    /** Clearance off the skull, in head radii. */
    clear?: number;
    /** Backward drift once it is falling free. */
    sway?: number;
    /**
     * Height at which the strand stops following the skull. A curtain hugs
     * all the way to the jaw; a ponytail leaves at the band and hangs behind
     * the head, and forcing it to hug produced a tail painted on the occiput.
     */
    hugTo?: number;
    /**
     * How far the free part swings clear of the skull, in head radii. A tail
     * leaving high on the crown has to clear a skull that keeps widening below
     * it, or it falls straight through the head.
     */
    push?: number;
    steps?: number;
    taper?: number;
    /** Per-t thickness multiplier, for braids and other shaped locks. */
    shape?: (t: number) => number;
  },
): Station[] {
  const { R, face } = ctx;
  const horiz = opts.dir.clone().setY(0).normalize();
  const clear = opts.clear ?? 0.02;
  const steps = opts.steps ?? 9;
  const taper = opts.taper ?? 0.3;
  // The jaw line, not the pole. Following the skull all the way down converges
  // on the chin — the horizontal radius goes to zero there — so the strand
  // then fell straight through the neck and torso and vanished. Every long
  // style came out neck-length because of it.
  const endY = opts.hugTo ?? -0.58;
  const push = opts.push ?? 0;

  // How much of the length is spent hugging the skull, as arc on the sphere.
  const hugArc = Math.max(0, Math.acos(THREE.MathUtils.clamp(endY, -1, 1))
    - Math.acos(THREE.MathUtils.clamp(opts.startY, -1, 1)));
  const hugFrac = Math.min(1, hugArc / Math.max(1e-3, opts.length));

  const onSkull = (y: number) => {
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return skullPoint(horiz.clone().multiplyScalar(r).setY(y), R, face, clear + opts.thick * 0.5);
  };

  const out: Station[] = [];
  const exit = onSkull(endY);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let pos: THREE.Vector3;
    if (t <= hugFrac) {
      const u = hugFrac > 0 ? t / hugFrac : 1;
      pos = onSkull(THREE.MathUtils.lerp(opts.startY, endY, u));
    } else {
      // Free fall, with a little drift away from the neck.
      const f = (t - hugFrac) / Math.max(1e-3, 1 - hugFrac);
      const fall = (opts.length - hugArc) * R * f;
      // The swing clear happens fast, the drift slowly: hair leaves the head
      // in the first few centimetres and then just hangs.
      const out = (push * Math.min(1, f * 4) + (opts.sway ?? 0.10) * f) * R;
      pos = exit.clone().add(new THREE.Vector3(horiz.x * out, -fall, horiz.z * out));
    }
    const k = opts.shape ? opts.shape(t) : 1;
    out.push({
      pos,
      radiusX: opts.thick * R * k * (1 - taper * t),
      radiusZ: opts.thick * R * k * 0.72 * (1 - taper * t),
      bone: 'Head',
      blendBone: 'Neck',
      blendWeight: Math.min(0.45, Math.max(0, t - hugFrac * 0.5) * 0.8),
      squareness: 2.5,
    });
  }
  return out;
}

/**
 * A curtain of hair down one side of the face. Three strands rather than one:
 * a single tube of the right volume is 8 cm across and reads as a headphone.
 */
function curtain(ctx: StyleContext, side: number, opts: { length: number; thick: number; z: number }): Station[][] {
  return [0.28, 0.0, -0.34].map((skew, i) => drape(ctx, {
    dir: V(side * 0.94, 0, opts.z + skew),
    startY: 0.46 - Math.abs(skew) * 0.1,
    length: opts.length * (1 - Math.abs(skew) * 0.18),
    thick: opts.thick * (i === 1 ? 1 : 0.86),
    clear: 0.028 + i * 0.004,
    sway: 0.06,
  }));
}

/** The mass at the back of the head — usually most of the silhouette. */
function backMass(ctx: StyleContext, opts: { length: number; thick: number; width: number }): Station[][] {
  // Six strands, not four: from directly behind, four of the volume needed to
  // read as hair are four tubes, and the avatar's back is exactly where the
  // camera sits while you walk.
  return [-0.78, -0.47, -0.16, 0.16, 0.47, 0.78].map((x) => drape(ctx, {
    dir: V(x * opts.width, 0, -1),
    startY: 0.40,
    length: opts.length,
    thick: opts.thick,
    clear: 0.025,
    sway: 0.08,
  }));
}

/**
 * A gathered tail. It leaves the band already clear of the skull — a tail that
 * starts on the scalp and falls vertically spends its first 15 cm inside the
 * head — and pinches just below the tie, which is the one detail that says
 * "tied" rather than "lump".
 */
function tail(ctx: StyleContext, opts: { anchorY: number; length: number; thick: number; kink: number }): Station[] {
  return drape(ctx, {
    dir: V(0, 0, -1),
    startY: opts.anchorY,
    length: opts.length,
    thick: opts.thick,
    clear: 0.05,
    sway: 0.10,
    // Leaves the band and hangs: hugging to the jaw painted the tail flat on
    // the back of the skull.
    hugTo: 0.30,
    push: 0.55,
    steps: 10,
    taper: 0.45,
    shape: (t) => (t < 0.16 ? 0.5 : 1.15 - Math.sin(t * 2.6) * opts.kink),
  });
}

/** Two braids, with the bulge cycle that makes a tube read as plaited. */
function braids(ctx: StyleContext, opts: { length: number; thick: number }): Station[][] {
  return [-1, 1].map((side) => drape(ctx, {
    dir: V(side * 0.55, 0, -0.9),
    startY: 0.44,
    length: opts.length,
    thick: opts.thick,
    clear: 0.03,
    sway: 0.08,
    hugTo: 0.18,
    push: 0.34,
    steps: 13,
    taper: 0.28,
    shape: (t) => 1 + Math.sin(t * 16) * 0.26,
  }));
}

// --------------------------------------------------------------------------
// Styles
// --------------------------------------------------------------------------

/**
 * A hairline: the height above which hair grows, HIGH across the forehead and
 * low at the nape. The first version added the forward-facing weight to the
 * height instead of to the threshold, which grew the most hair exactly where
 * there should be none — every style came out as a mask over the face.
 *
 * `front` is the threshold at the forehead, `back` at the nape; the sides
 * interpolate between them.
 */
const hairline = (n: THREE.Vector3, front: number, side: number, back: number) => {
  // Three anchors, not two. Interpolating forehead straight to nape gave the
  // temples the NAPE's hairline, so every style grew hair over the ears and
  // down the cheek.
  const t = Math.pow(Math.abs(n.z), 1.2);
  const threshold = n.z >= 0
    ? THREE.MathUtils.lerp(side, front, t)
    : THREE.MathUtils.lerp(side, back, t);
  // A wide ramp on purpose: the sphere steps about 0.07 of n.y per ring here,
  // so a narrow transition lands on two quad rows and reads as stair steps.
  return smooth(threshold - 0.20, threshold + 0.12, n.y);
};

export const HAIR_STYLES: Record<string, HairStyle> = {
  // --- short ------------------------------------------------------------
  hair_buzz_01: {
    thickness: 0.012,
    base: (n) => hairline(n, 0.34, 0.06, -0.24),
  },

  hair_crop_01: {
    thickness: 0.026,
    base: (n) => hairline(n, 0.30, 0.04, -0.26),
    locks: (ctx) => fan(ctx, 7, { fromX: -0.52, toX: 0.52, y: 0.66, z: 0.58 },
      (u) => V((u - 0.5) * 0.5, 0.30, 1), { length: 0.26, thick: 0.080, sag: 0.9, jitter: 0.02 }),
  },

  hair_wave_01: {
    thickness: 0.034,
    base: (n) => hairline(n, 0.28, 0.04, -0.26),
    locks: (ctx) => [
      // Swept back off the forehead: the strands leave toward -Z, so the
      // silhouette gains a crest instead of a helmet.
      ...fan(ctx, 9, { fromX: -0.58, toX: 0.58, y: 0.62, z: 0.62 },
        (u) => V((u - 0.5) * 0.7, 0.55, -1), { length: 0.62, thick: 0.088, sag: 0.35, wave: 0.02, jitter: 0.03 }),
      ...fan(ctx, 5, { fromX: -0.72, toX: 0.72, y: 0.18, z: 0.10 },
        (u) => V(Math.sign(u - 0.5) * 0.6, 0.1, -1), { length: 0.34, thick: 0.072, sag: 0.7 }),
    ],
  },

  hair_mohawk_01: {
    thickness: 0.008,
    base: (n) => hairline(n, 0.32, 0.10, -0.20),
    locks: (ctx) => {
      // Rooted along the midline from brow to crown, tall in the middle. The
      // first pass rooted all nine at one point and offset them afterwards,
      // which produced antennae floating clear of the skull.
      const out: Station[][] = [];
      const n = 11;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const zDir = THREE.MathUtils.lerp(0.85, -0.85, u);
        const height = 0.16 + Math.sin(u * Math.PI) * 0.30;
        out.push(lock(ctx, V(0, Math.sqrt(Math.max(0.04, 1 - zDir * zDir)), zDir),
          V(0, 1, zDir * 0.25), { length: height, thick: 0.075, sag: 0.06, taper: 0.55, steps: 3 }));
      }
      return out;
    },
  },

  hair_afro_01: {
    thickness: 0.080,
    base: (n) => hairline(n, 0.26, 0.02, -0.28) * (0.88 + 0.12 * Math.sin(n.x * 21) * Math.sin(n.z * 21)),
    locks: (ctx) => {
      // Clumps rather than one smooth ball: an afro reads by its broken edge.
      const out: Station[][] = [];
      for (let i = 0; i < 22; i++) {
        const a = i * 2.39996;
        const y = 0.85 - (i / 22) * 1.35;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        out.push(lock(ctx, V(Math.cos(a) * r, y, Math.sin(a) * r), V(Math.cos(a) * r, y * 0.6 + 0.4, Math.sin(a) * r),
          { length: 0.05, thick: 0.115, sag: 0.05, taper: 0.05, steps: 2 }));
      }
      return out;
    },
  },

  // --- medium and long ---------------------------------------------------
  hair_bob_01: {
    thickness: 0.030,
    base: (n) => hairline(n, 0.26, -0.05, -0.40),
    locks: (ctx) => [
      ...curtain(ctx, -1, { length: 1.75, thick: 0.115, z: -0.10 }),
      ...curtain(ctx, 1, { length: 1.75, thick: 0.115, z: -0.10 }),
      ...backMass(ctx, { length: 1.85, thick: 0.092, width: 0.5 }),
      ...fan(ctx, 6, { fromX: -0.46, toX: 0.46, y: 0.60, z: 0.66 },
        (u) => V((u - 0.5) * 1.4, -0.35, 0.6), { length: 0.42, thick: 0.085, sag: 0.8, jitter: 0.02 }),
    ],
  },

  hair_long_01: {
    thickness: 0.032,
    base: (n) => hairline(n, 0.24, -0.06, -0.45),
    locks: (ctx) => [
      ...curtain(ctx, -1, { length: 3.3, thick: 0.125, z: -0.05 }),
      ...curtain(ctx, 1, { length: 3.3, thick: 0.125, z: -0.05 }),
      ...backMass(ctx, { length: 3.5, thick: 0.105, width: 0.7 }),
      ...fan(ctx, 5, { fromX: -0.42, toX: 0.42, y: 0.62, z: 0.64 },
        (u) => V((u - 0.5) * 1.8, -0.3, 0.5), { length: 0.5, thick: 0.080, sag: 0.9, jitter: 0.02 }),
    ],
  },

  hair_ponytail_01: {
    thickness: 0.024,
    base: (n) => hairline(n, 0.28, 0.02, -0.32),
    locks: (ctx) => [
      tail(ctx, { anchorY: 0.60, length: 2.9, thick: 0.20, kink: 0.10 }),
      ...fan(ctx, 4, { fromX: -0.38, toX: 0.38, y: 0.66, z: 0.60 },
        (u) => V((u - 0.5) * 1.2, 0.1, -0.9), { length: 0.34, thick: 0.075, sag: 0.5 }),
    ],
  },

  hair_braids_01: {
    thickness: 0.028,
    base: (n) => hairline(n, 0.28, 0.02, -0.34) * (0.9 + 0.1 * Math.sin(Math.atan2(n.x, n.z) * 9)),
    locks: (ctx) => braids(ctx, { length: 3.0, thick: 0.090 }),
  },
};

// --------------------------------------------------------------------------
// Build
// --------------------------------------------------------------------------

/** The scalp cap, laid on the sculpted skull rather than on a bare sphere. */
function scalp(style: HairStyle, ctx: StyleContext): THREE.BufferGeometry | null {
  const { R, face } = ctx;
  const geo = new THREE.SphereGeometry(1, 56, 40);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  const keep: boolean[] = [];
  let any = false;

  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    const cover = style.base(n);
    const on = cover > 0.02;
    keep.push(on);
    any = any || on;

    // The cap does not END at the hairline — it DIVES under the skin there.
    // Cutting it at a threshold puts the boundary on the sphere's quad grid,
    // and since the mask ramp spans barely two rings the hairline comes out as
    // visible stair steps. Below 35% coverage the cap is buried; above 85% it
    // floats clear of the skin it would otherwise z-fight; in between it
    // emerges, so what a player sees is hair growing out of a scalp.
    const buried = 1 - smooth(0.35, 0.85, cover);
    const lift = cover * style.thickness + 0.006 - 0.026 * buried;
    const p = skullPoint(n, R, face, lift);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  if (!any) return null;

  const idx = geo.getIndex()!;
  const kept: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (keep[a] || keep[b] || keep[c]) kept.push(a, b, c);
  }
  geo.setIndex(kept);
  geo.computeVertexNormals();

  const count = pos.count;
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { si[i * 4] = BONE_INDEX.Head; sw[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setAttribute('uv1', geo.attributes.uv.clone());
  return geo;
}

export function buildHair(
  rig: BuiltRig,
  face: FaceShape,
  styleId: string,
  colorIndex: number,
): THREE.SkinnedMesh | null {
  const style = HAIR_STYLES[styleId];
  if (!style) return null;

  const R = headRadius(rig, face);
  const ctx: StyleContext = { R, face };
  const pieces: THREE.BufferGeometry[] = [];

  const cap = scalp(style, ctx);
  if (cap) pieces.push(cap);

  const locks = style.locks?.(ctx) ?? [];
  if (locks.length) {
    pieces.push(assemble(locks.map((st) => loft(st, {
      segments: 8, capStart: true, capEnd: true, capRound: 0.8, subdivisions: 2,
    }))));
  }
  if (!pieces.length) return null;

  const geo = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces);
  geo.computeVertexNormals();
  const c = headCentre(rig, face);
  geo.translate(0, rig.restWorld.Head.y + c.y, c.z);

  const mesh = new THREE.SkinnedMesh(geo, makeHairMaterial(colorIndex));
  mesh.name = 'hair';
  mesh.castShadow = true;
  return mesh;
}
