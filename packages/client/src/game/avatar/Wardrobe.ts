import * as THREE from 'three';
import { loft, assemble, sliceStationsByY, type Station } from './Loft.js';
import type { BoneName, BuiltRig } from './Skeleton.js';
import { BONE_INDEX } from './Skeleton.js';
import { type BodyShape, torso, arm, leg, limbGirth, clampLegStation } from './BodyBuilder.js';
import { makeClothMaterial, makeHairMaterial } from './Materials.js';

/**
 * Garments are lofted over the same rest pose as the body with an inflation
 * offset, so they share the skeleton exactly (SPECs §13) and never require a
 * per-combination mesh. Anything the garment fully covers can be skipped by
 * the body shader, but at this polygon count it is cheaper to just let it be
 * hidden than to build per-garment body masks.
 *
 * Every band is sampled from the BODY's own station path rather than from a
 * second, hand-written set of radii. Two independent profiles is what put skin
 * outside the shirt at the glutes: the body drifts back in Z there and the
 * garment did not. Derived bands cannot drift, for any preset ever added.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface GarmentSpec {
  stations: Station[];
  segments: number;
  capStart?: boolean;
  capEnd?: boolean;
  capRound?: number;
}

function inflate(s: Station, dx: number, dz = dx): Station {
  return { ...s, pos: s.pos.clone(), radiusX: s.radiusX + dx, radiusZ: s.radiusZ + dz };
}

/**
 * The waist contract. Every top hems at or below {@link HEM_MAX}, every
 * bottom's waistband rises to at least {@link WAIST_MIN}, both measured from
 * the Hips bone and scaled with the rig — so the two always overlap by ~10 cm
 * and no combination can expose a band of skin. A deliberate crop top would
 * have to change this constant and the gate together, on purpose.
 */
export const HEM_MAX = -0.02;
export const WAIST_MIN = 0.075;

/**
 * The thickest waistband in the catalogue. Tops inflate by this much extra
 * below the waist, which is what keeps an untucked shirt reliably OUTSIDE the
 * trousers instead of fighting them for the same millimetre.
 */
const WAISTBAND_MAX = 0.028;

const hipsRef = (rig: BuiltRig, d: number) => rig.restWorld.Hips.y + d * rig.proportions.height;

// --------------------------------------------------------------------------
// Tops
// --------------------------------------------------------------------------

/**
 * A tube of cloth over the trunk, sampled from the body's own torso profile.
 * `overWaistband` is what an untucked top passes so it clears any trousers it
 * might meet; a bottom passes false and stays against the body.
 */
function torsoBand(
  rig: BuiltRig,
  s: BodyShape,
  fromY: number,
  toY: number,
  thickness: number,
  overWaistband = false,
): Station[] {
  const h = rig.proportions.height;
  const seam = hipsRef(rig, WAIST_MIN);
  return sliceStationsByY(torso(rig, s), fromY, toY).map((st) => {
    // Cloth hangs squarer than flesh; the extra corner is most of what makes a
    // jacket read as a jacket rather than as a painted-on skin.
    //
    // The clearance for the waistband fades in over ~11 cm instead of
    // switching on at the seam. Applied as a step it built a literal shelf
    // around the hips, which looked worse than the defect it was fixing.
    const fade = 1 - THREE.MathUtils.smoothstep(st.pos.y, seam - 0.02 * h, seam + 0.09 * h);
    const extra = overWaistband ? WAISTBAND_MAX * fade : 0;
    return {
      ...inflate(st, thickness + extra),
      squareness: Math.min(3.2, (st.squareness ?? 2) + 0.12),
    };
  });
}

/**
 * Closes a band's end with a lip that turns under instead of a filled dome.
 * The old flat-capped band grew a 9 cm rounded blob inside the garment, which
 * is fine while it is buried and grotesque the moment a hem is visible.
 * `dir` is -1 for a hem that hangs down, +1 for a collar that turns up.
 */
function lip(st: Station, dir: -1 | 1, depth: number, shrink = 0.93): Station[] {
  const mid = THREE.MathUtils.lerp(1, shrink, 0.35);
  return [
    { ...st, pos: st.pos.clone().add(V(0, dir * depth * 0.5, 0)), radiusX: st.radiusX * mid, radiusZ: st.radiusZ * mid },
    { ...st, pos: st.pos.clone().add(V(0, dir * depth, 0)), radiusX: st.radiusX * shrink, radiusZ: st.radiusZ * shrink },
  ];
}

/**
 * A sleeve, taken from the arm it covers. `to` is how far down the arm's own
 * station chain the cloth reaches: 3 is mid-biceps, 5 the elbow, 7 the wrist.
 *
 * The hand-written radius ramp this replaces ran THINNER than the biceps it
 * was supposed to cover, so the shoulder ended as a floating white box with
 * the deltoid poking out beside it.
 */
function sleeve(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right', to: number, thickness: number): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const t = limbGirth(s);
  const sign = side === 'Left' ? 1 : -1;
  const shoulder = rig.restWorld[L('Arm')];

  // A socket ring pushed inboard, so the open top of the sleeve is buried
  // inside the torso band instead of showing as a hole at the armpit.
  const out: Station[] = [{
    pos: shoulder.clone().add(V(-sign * 0.045, 0.016, 0)),
    radiusX: 0.080 * t + thickness,
    radiusZ: 0.078 * t + thickness,
    bone: L('Arm'),
    blendBone: 'Spine2',
    blendWeight: 0.55,
    squareness: 2.4,
  }];

  for (const st of arm(rig, s, side).slice(0, to + 1)) {
    out.push({ ...inflate(st, thickness), squareness: Math.min(3.0, (st.squareness ?? 2) + 0.15) });
  }

  // A cuff flare stops the sleeve ending in a hard cylinder edge.
  const last = out[out.length - 1];
  out.push({ ...last, pos: last.pos.clone().add(V(0, -0.014, 0)), radiusX: last.radiusX * 1.06, radiusZ: last.radiusZ * 1.06 });
  return out;
}

/**
 * A trouser leg: the body's own leg profile from the waistband down to a hem,
 * inflated and flared. Because it is derived, it inherits the clearance the
 * body already opened between the knees — and it re-clamps afterwards, so the
 * flare of a wide-leg cut cannot close the gap back up.
 */
function legWrap(
  rig: BuiltRig,
  s: BodyShape,
  side: 'Left' | 'Right',
  hemY: number,
  thickness: number,
  flare = 1,
): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const top = hipsRef(rig, WAIST_MIN);
  const band = sliceStationsByY(leg(rig, s, side), hemY, top);
  const hipY = rig.restWorld[L('UpLeg')].y;
  const span = Math.max(1e-4, hipY - hemY);

  const out = band.map((st) => {
    // Flare grows toward the hem, which is what separates trousers from tights.
    const f = THREE.MathUtils.lerp(1, flare, THREE.MathUtils.clamp((hipY - st.pos.y) / span, 0, 1));
    return clampLegStation({
      ...st,
      pos: st.pos.clone(),
      radiusX: st.radiusX * f + thickness,
      radiusZ: st.radiusZ * f + thickness,
      squareness: Math.min(3.0, (st.squareness ?? 2) + 0.2),
    }, rig);
  });

  // Path runs top-down; the hem is the last ring.
  const last = out[out.length - 1];
  out.push(...lip(last, -1, 0.022).map((st) => clampLegStation(st, rig)));
  return out;
}

/**
 * A shoe, likewise derived from the foot it has to fit. `chunky` thickens the
 * sole and the toe box but NOT the width: the two shoes used to be 19 cm wide
 * each on a 20 cm stance, which is the whole reason they read as one block.
 */
function shoe(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right', chunky: number): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = limbGirth(s);
  const foot = rw[L('Foot')];
  const toe = rw[L('ToeBase')];
  const k = 0.007 * chunky;
  const collar = foot.y + 0.034;

  // Ankle collar, taken from the leg so the shoe meets the shin cleanly.
  const shaft = sliceStationsByY(leg(rig, s, side), foot.y - 0.006, collar)
    .map((st) => inflate(st, 0.008 + k * 0.35));

  const sole: Station[] = [
    { pos: foot.clone().add(V(0, -0.030, 0.006)), radiusX: 0.040 * t, radiusZ: 0.058 * t + k, bone: L('Foot'), squareness: 2.9 },
    { pos: foot.clone().add(V(0, -0.056, 0.064)), radiusX: 0.043 * t, radiusZ: 0.066 * t + k, bone: L('Foot'), squareness: 3.3 },
    { pos: toe.clone().add(V(0, 0.010, 0.028)), radiusX: 0.041 * t, radiusZ: 0.050 * t + k, bone: L('ToeBase'), blendBone: L('Foot'), blendWeight: 0.45, squareness: 3.3 },
    { pos: toe.clone().add(V(0, 0.014, 0.064)), radiusX: 0.032 * t, radiusZ: 0.032 * t, bone: L('ToeBase'), squareness: 2.8 },
    { pos: toe.clone().add(V(0, 0.017, 0.080)), radiusX: 0.015 * t, radiusZ: 0.014 * t, bone: L('ToeBase') },
  ];

  return [...shaft, ...sole].map((st) => clampLegStation(st, rig));
}

// --------------------------------------------------------------------------
// Hair
// --------------------------------------------------------------------------

/**
 * Hair is a shell offset from the head sphere, carved by a mask function that
 * defines the hairline. Each style is just a different mask plus a different
 * outward thickness, so a new style costs a few lines rather than a model.
 */
interface HairStyle {
  /** Returns shell thickness at a unit-sphere direction, 0 = no hair. */
  mask: (n: THREE.Vector3) => number;
  /** Optional trailing volume (ponytail, braid) as extra lofts. */
  extras?: (rig: BuiltRig, R: number) => Station[][];
}

const smooth = (e0: number, e1: number, x: number) => THREE.MathUtils.smoothstep(x, e0, e1);

const HAIR_STYLES: Record<string, HairStyle> = {
  hair_buzz_01: {
    mask: (n) => 0.006 * smooth(-0.12, 0.16, n.y) * (1 - 0.45 * Math.max(0, n.z) * smooth(0.1, 0.5, n.y)),
  },
  hair_bob_01: {
    mask: (n) => {
      // Falls to just below the ear line, with a fringe at the front.
      const cap = smooth(-0.52, -0.18, n.y);
      const fringe = Math.max(0, n.z) * smooth(0.05, 0.42, n.y);
      const back = Math.max(0, -n.z) * smooth(-0.62, -0.1, n.y);
      return (0.014 + 0.012 * fringe + 0.018 * back) * cap;
    },
  },
  hair_ponytail_01: {
    mask: (n) => 0.013 * smooth(-0.2, 0.1, n.y) * (1 - 0.3 * Math.max(0, -n.z)),
    extras: (rig, R) => {
      const head = rig.restWorld.Head;
      const base = new THREE.Vector3(0, head.y + R * 0.7, -R * 0.92);
      const st: Station[] = [];
      for (let i = 0; i <= 7; i++) {
        const t = i / 7;
        st.push({
          pos: base.clone().add(V(0, -t * R * 2.1, -t * R * 0.5 - Math.sin(t * 2.6) * R * 0.22)),
          radiusX: R * (0.30 - t * 0.2) * (1 + Math.sin(t * 5) * 0.08),
          radiusZ: R * (0.28 - t * 0.19),
          bone: 'Head',
        });
      }
      return [st];
    },
  },
  hair_afro_01: {
    mask: (n) => 0.055 * smooth(-0.42, -0.05, n.y) * (0.85 + 0.15 * Math.sin(n.x * 22) * Math.sin(n.z * 22)),
  },
  hair_long_01: {
    mask: (n) => {
      const cap = smooth(-0.35, 0.0, n.y);
      const back = Math.max(0, -n.z);
      return (0.015 + 0.02 * back) * cap;
    },
    extras: (rig, R) => {
      const head = rig.restWorld.Head;
      const lofts: Station[][] = [];
      for (const side of [-1, 1]) {
        const st: Station[] = [];
        for (let i = 0; i <= 8; i++) {
          const t = i / 8;
          st.push({
            pos: new THREE.Vector3(side * R * (0.72 - t * 0.12), head.y + R * 0.5 - t * R * 3.0, -R * (0.45 + t * 0.25)),
            radiusX: R * (0.34 - t * 0.14),
            radiusZ: R * (0.26 - t * 0.12),
            bone: 'Head',
            blendBone: 'Neck',
            blendWeight: Math.min(0.45, t * 0.6),
          });
        }
        lofts.push(st);
      }
      return lofts;
    },
  },
  hair_braids_01: {
    mask: (n) => 0.017 * smooth(-0.28, 0.06, n.y) * (0.9 + 0.1 * Math.sin(Math.atan2(n.x, n.z) * 9)),
    extras: (rig, R) => {
      const head = rig.restWorld.Head;
      const lofts: Station[][] = [];
      for (const side of [-1, 1]) {
        const st: Station[] = [];
        for (let i = 0; i <= 9; i++) {
          const t = i / 9;
          // The bulge cycle is what makes a tube read as a braid.
          const bulge = 1 + Math.sin(t * 14) * 0.22;
          st.push({
            pos: new THREE.Vector3(side * R * (0.66 - t * 0.06), head.y + R * 0.35 - t * R * 2.6, -R * (0.35 + t * 0.15)),
            radiusX: R * 0.2 * bulge * (1 - t * 0.35),
            radiusZ: R * 0.2 * bulge * (1 - t * 0.35),
            bone: 'Head',
            blendBone: 'Neck',
            blendWeight: Math.min(0.4, t * 0.55),
          });
        }
        lofts.push(st);
      }
      return lofts;
    },
  },
  hair_mohawk_01: {
    mask: (n) => {
      const strip = Math.exp(-Math.pow(n.x / 0.16, 2));
      const sides = 0.006 * smooth(-0.3, 0.1, n.y);
      return sides + 0.075 * strip * smooth(-0.05, 0.45, n.y);
    },
  },
};

export function buildHair(rig: BuiltRig, styleId: string, colorIndex: number): THREE.SkinnedMesh | null {
  const style = HAIR_STYLES[styleId];
  if (!style) return null;

  const R = 0.128 * rig.proportions.headScale * rig.proportions.height;
  const headY = rig.restWorld.Head.y + R * 0.42;
  const shell = new THREE.SphereGeometry(R, 36, 28);
  const pos = shell.attributes.position as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  const keep: boolean[] = [];

  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    const thick = style.mask(n);
    keep.push(thick > 0.0035);
    // Match the head sculpt's cranium flattening so hair sits on the skull.
    const sy = THREE.MathUtils.lerp(1.0, 1.06, Math.max(0, n.y));
    const sz = THREE.MathUtils.lerp(1.0, 0.93, Math.max(0, -n.z) * Math.max(0, n.y));
    const r = R + thick + 0.004;
    pos.setXYZ(i, n.x * r * 0.9, n.y * r * sy, n.z * r * sz * 0.94);
  }

  // Drop faces whose vertices all fall outside the mask, leaving an open cap.
  const idx = shell.getIndex()!;
  const kept: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (keep[a] || keep[b] || keep[c]) kept.push(a, b, c);
  }
  shell.setIndex(kept);
  shell.computeVertexNormals();
  shell.translate(0, headY, 0.008);

  const count = pos.count;
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { si[i * 4] = BONE_INDEX.Head; sw[i * 4] = 1; }
  shell.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  shell.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  shell.setAttribute('uv1', shell.attributes.uv.clone());

  let geo: THREE.BufferGeometry = shell;
  const extras = style.extras?.(rig, R);
  if (extras?.length) {
    const parts = extras.map((st) => loft(st, { segments: 12, capStart: true, capEnd: true, subdivisions: 2 }));
    const extraGeo = assemble(parts);
    geo = mergeSkinned([shell, extraGeo]);
  }

  const mesh = new THREE.SkinnedMesh(geo, makeHairMaterial(colorIndex));
  mesh.name = 'hair';
  mesh.castShadow = true;
  return mesh;
}

/** Concatenates skinned geometries that already share a skeleton. */
export function mergeSkinned(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const attrs = ['position', 'normal', 'uv'] as const;
  const sizes: Record<string, number> = { position: 3, normal: 3, uv: 2 };
  const acc: Record<string, number[]> = { position: [], normal: [], uv: [], skinIndex: [], skinWeight: [] };
  const indices: number[] = [];
  let offset = 0;

  for (const g of geos) {
    for (const a of attrs) {
      const attr = g.getAttribute(a) as THREE.BufferAttribute;
      for (let i = 0; i < attr.count * sizes[a]; i++) acc[a].push(attr.array[i] as number);
    }
    const si = g.getAttribute('skinIndex') as THREE.BufferAttribute;
    const sw = g.getAttribute('skinWeight') as THREE.BufferAttribute;
    for (let i = 0; i < si.count * 4; i++) acc.skinIndex.push(si.array[i] as number);
    for (let i = 0; i < sw.count * 4; i++) acc.skinWeight.push(sw.array[i] as number);

    const idx = g.getIndex();
    const count = (g.getAttribute('position') as THREE.BufferAttribute).count;
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
    else for (let i = 0; i < count; i++) indices.push(i + offset);
    offset += count;
  }

  out.setAttribute('position', new THREE.Float32BufferAttribute(acc.position, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(acc.normal, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
  out.setAttribute('uv1', new THREE.Float32BufferAttribute(acc.uv, 2));
  out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(acc.skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(acc.skinWeight, 4));
  out.setIndex(indices);
  out.computeBoundingSphere();
  return out;
}

// --------------------------------------------------------------------------
// Garment registry
// --------------------------------------------------------------------------

export interface GarmentBuild {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

type Builder = (rig: BuiltRig, shape: BodyShape, color: string) => GarmentBuild;

const build = (specs: GarmentSpec[], material: THREE.Material): GarmentBuild => ({
  geometry: assemble(specs.map((s) => loft(s.stations, {
    segments: s.segments, capStart: s.capStart, capEnd: s.capEnd,
    capRound: s.capRound, subdivisions: 2,
  }))),
  material,
});

/**
 * A top: trunk band with a turned hem, plus two sleeves. `hem` is quoted from
 * the Hips bone and is clamped to {@link HEM_MAX}, so no top in the catalogue
 * can be authored short enough to bare the waist.
 */
function topBody(rig: BuiltRig, s: BodyShape, hem: number, thickness: number): GarmentSpec[] {
  const hemY = hipsRef(rig, Math.min(hem, HEM_MAX));
  const band = torsoBand(rig, s, hemY, 999, thickness, true);
  // The hem turns under all the way back to the skin. Left flared, its closing
  // disc was wider than the trousers and showed between the thighs as a white
  // wedge — the shirt reading as a nappy.
  const skin = sliceStationsByY(torso(rig, s), hemY, hemY + 0.002)[0];
  // Tucked to just INSIDE the skin: a hem that stops flush with the body still
  // leaves a millimetre of white rim showing between the thighs.
  const shrink = THREE.MathUtils.clamp((skin.radiusX * 0.93) / band[0].radiusX, 0.55, 0.99);
  const stations = [...lip(band[0], -1, 0.018, shrink).reverse(), ...band];
  return [{ stations, segments: 22, capStart: true, capEnd: true, capRound: 0.2 }];
}

export const TOP_BUILDERS: Record<string, Builder> = {
  top_tee_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.055, 0.011),
    { stations: sleeve(rig, s, 'Left', 3, 0.012), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 3, 0.012), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.86, sheen: 0.28 })),

  top_hoodie_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.07, 0.026),
    { stations: sleeve(rig, s, 'Left', 7, 0.024), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 7, 0.024), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.92, sheen: 0.18 })),

  top_jacket_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.04, 0.032),
    { stations: sleeve(rig, s, 'Left', 7, 0.03), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 7, 0.03), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.44, sheen: 0.5, metalness: 0.05 })),

  top_blazer_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.09, 0.022),
    { stations: sleeve(rig, s, 'Left', 7, 0.02), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 7, 0.02), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.68, sheen: 0.42 })),

  // Was a crop top, and it was the loudest single source of bare midriff in
  // the matrix. It keeps its metallic sheen and now respects the waist seam.
  top_holo_01: (rig, s, color) => build(
    topBody(rig, s, -0.035, 0.009),
    makeClothMaterial({ color, roughness: 0.18, metalness: 0.55, sheen: 0.9, emissive: color, emissiveIntensity: 0.35 }),
  ),
};

/** Waistband + two legs. The band always reaches {@link WAIST_MIN}. */
function trousers(
  rig: BuiltRig,
  s: BodyShape,
  hemAboveAnkle: number,
  thickness: number,
  flare: number,
): GarmentSpec[] {
  // Quoted from the ankle, not from the hips: the leg-length presets move the
  // two apart, and a hem measured from the wrong end rides up on short legs.
  const hemY = rig.restWorld.LeftFoot.y + hemAboveAnkle;
  return [
    // The waistband's top ring is closed even though a top always hides it:
    // an open ring shows its own backfaces the day someone authors a shorter
    // hem, and the disc costs 22 triangles buried inside the belly.
    { stations: torsoBand(rig, s, -999, hipsRef(rig, WAIST_MIN), thickness), segments: 22, capStart: true, capEnd: true, capRound: 0.1 },
    { stations: legWrap(rig, s, 'Left', hemY, thickness, flare), segments: 16, capEnd: true, capRound: 0.25 },
    { stations: legWrap(rig, s, 'Right', hemY, thickness, flare), segments: 16, capEnd: true, capRound: 0.25 },
  ];
}

export const BOTTOM_BUILDERS: Record<string, Builder> = {
  bottom_jeans_01: (rig, s, color) => build(
    trousers(rig, s, 0.052, 0.014, 1.06),
    makeClothMaterial({ color, roughness: 0.88, sheen: 0.22 }),
  ),

  bottom_cargo_01: (rig, s, color) => build(
    trousers(rig, s, 0.068, 0.026, 1.18),
    makeClothMaterial({ color, roughness: 0.9, sheen: 0.16 }),
  ),

  bottom_track_01: (rig, s, color) => build(
    trousers(rig, s, 0.032, 0.022, 0.92),
    makeClothMaterial({ color, roughness: 0.6, sheen: 0.5 }),
  ),

  bottom_skirt_01: (rig, s, color) => {
    const m = s.mass;
    const topY = hipsRef(rig, WAIST_MIN);
    const hemY = hipsRef(rig, -0.32);
    // The waistband is the body's own profile; only below the hip does the
    // A-line take over, which is the whole silhouette of the garment.
    // Descending, waist first: sliceStationsByY hands back the body's own
    // ascending order, and a path that doubles back on itself makes the
    // parallel-transport frame flip 180° and the whole garment turn to noise.
    const band = torsoBand(rig, s, hipsRef(rig, -0.05), topY, 0.016).slice().reverse();
    const st: Station[] = [...band];
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      st.push({
        pos: V(0, THREE.MathUtils.lerp(hipsRef(rig, -0.05), hemY, t), -0.004),
        radiusX: (0.16 + t * 0.12) * m,
        radiusZ: (0.125 + t * 0.10) * m,
        bone: 'Hips',
        // Pleats.
        squareness: 2.1,
        scale: 1 + Math.sin(t * 3) * 0.01,
      });
    }
    st.push(...lip(st[st.length - 1], -1, 0.018));
    return build([{ stations: st, segments: 30, capStart: true, capEnd: true, capRound: 0.15 }],
      makeClothMaterial({ color, roughness: 0.8, sheen: 0.36 }));
  },
};

const shoePair = (rig: BuiltRig, s: BodyShape, chunky: number): GarmentSpec[] => [
  { stations: shoe(rig, s, 'Left', chunky), segments: 16, capStart: true, capEnd: true, capRound: 0.5 },
  { stations: shoe(rig, s, 'Right', chunky), segments: 16, capStart: true, capEnd: true, capRound: 0.5 },
];

export const SHOE_BUILDERS: Record<string, Builder> = {
  shoes_sneaker_01: (rig, s, color) => build(shoePair(rig, s, 1.0),
    makeClothMaterial({ color, roughness: 0.66, sheen: 0.3 })),

  shoes_boot_01: (rig, s, color) => build(shoePair(rig, s, 1.8),
    makeClothMaterial({ color, roughness: 0.4, sheen: 0.55 })),

  shoes_glow_01: (rig, s, color) => build(shoePair(rig, s, 1.3),
    makeClothMaterial({ color, roughness: 0.3, sheen: 0.7, emissive: color, emissiveIntensity: 1.6 })),
};

/** Default colourways so the catalogue reads as designed rather than random. */
export const ITEM_COLORS: Record<string, string> = {
  top_tee_01: '#e8e4dd', top_hoodie_01: '#3d4550', top_jacket_01: '#2c3038',
  top_blazer_01: '#242a35', top_holo_01: '#7cd7ff',
  bottom_jeans_01: '#3f5570', bottom_cargo_01: '#6a6350', bottom_track_01: '#22242a',
  bottom_skirt_01: '#8a3f54',
  shoes_sneaker_01: '#f0eeea', shoes_boot_01: '#241f1c', shoes_glow_01: '#39d98a',
};
