import * as THREE from 'three';
import { loft, assemble, sliceStationsByY, type Station } from './Loft.js';
import type { BoneName, BuiltRig } from './Skeleton.js';
import { type BodyShape, torso, arm, leg, limbGirth, clampLegStation } from './BodyBuilder.js';
import { makeClothMaterial } from './Materials.js';

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
// Garment registry
// --------------------------------------------------------------------------

export interface GarmentBuild {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/**
 * A wardrobe item. Returning an ARRAY is how a garment gets more than one
 * material: a varsity jacket's sleeves, a shoe's sole, a shirt's buttons.
 */
export type Builder = (rig: BuiltRig, shape: BodyShape, color: string) => GarmentBuild | GarmentBuild[];

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
function topBody(rig: BuiltRig, s: BodyShape, hem: number, thickness: number, topY = 999): GarmentSpec[] {
  const hemY = hipsRef(rig, Math.min(hem, HEM_MAX));
  const band = torsoBand(rig, s, hemY, topY, thickness, true);
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

/**
 * A collar: a short band above the shoulders that turns OUTWARD at the top.
 * The turn is the whole point — a collar that only goes up is a tube, and a
 * tube around a neck reads as a brace.
 */
function collar(
  rig: BuiltRig,
  s: BodyShape,
  opts: { from: number; to: number; thickness: number; flare?: number },
): GarmentSpec {
  const rw = rig.restWorld;
  const band = torsoBand(rig, s, rw.Neck.y + opts.from, rw.Neck.y + opts.to, opts.thickness);
  const flare = opts.flare ?? 1.22;
  const top = band[band.length - 1];
  band.push({
    ...top,
    pos: top.pos.clone().add(V(0, 0.022, -0.004)),
    radiusX: top.radiusX * flare,
    radiusZ: top.radiusZ * flare,
    squareness: Math.min(3.0, (top.squareness ?? 2) + 0.3),
  });
  return { stations: band, segments: 18, capStart: false, capEnd: true, capRound: 0.15 };
}

/**
 * A button placket: a raised strip down the centre front. It is what tells a
 * shirt apart from a tee at 60 px, and it costs one loft.
 */
function placket(rig: BuiltRig, s: BodyShape, fromY: number, toY: number, thickness: number): GarmentSpec {
  const band = sliceStationsByY(torso(rig, s), fromY, toY);
  const stations: Station[] = band.map((st) => ({
    pos: V(0, st.pos.y, st.pos.z + st.radiusZ + thickness + 0.004),
    radiusX: 0.026,
    radiusZ: 0.008,
    bone: st.bone,
    blendBone: st.blendBone,
    blendWeight: st.blendWeight,
    squareness: 3.0,
    roll: Math.PI / 2,
  }));
  return { stations, segments: 8, capStart: true, capEnd: true, capRound: 0.4 };
}

/**
 * Quilting: the horizontal ribs of a puffer. Modulating the per-station scale
 * is enough — the alternative is a separate tube per channel, which is twenty
 * lofts for a look that reads from the silhouette alone.
 */
function quilt(spec: GarmentSpec, ribs: number, depth: number): GarmentSpec {
  const n = spec.stations.length - 1;
  return {
    ...spec,
    stations: spec.stations.map((st, i) => ({
      ...st,
      scale: (st.scale ?? 1) * (1 + Math.sin((i / Math.max(1, n)) * Math.PI * 2 * ribs) * depth),
    })),
  };
}

/** A ribbed band, for a varsity hem or a knit cuff. */
function ribbed(stations: Station[], ribs = 4, depth = 0.05): Station[] {
  const n = stations.length - 1;
  return stations.map((st, i) => ({
    ...st,
    scale: (st.scale ?? 1) * (1 + Math.sin((i / Math.max(1, n)) * Math.PI * ribs) * depth),
  }));
}

/** Shoulder straps for a sleeveless top, over the trapezius. */
function straps(rig: BuiltRig, s: BodyShape, thickness: number): GarmentSpec[] {
  const rw = rig.restWorld;
  const m = s.mass;
  return (['Left', 'Right'] as const).map((side) => {
    const sign = side === 'Left' ? 1 : -1;
    const x = sign * 0.075 * m;
    const arc: Station[] = [
      { pos: V(x, rw.Spine2.y + 0.02, 0.088 * m), radiusX: 0.030, radiusZ: 0.012, bone: 'Spine2', squareness: 3.0 },
      { pos: V(x * 1.08, rw.Spine2.y + 0.098, 0.03 * m), radiusX: 0.030, radiusZ: 0.014, bone: 'Spine2', squareness: 3.0 },
      { pos: V(x * 1.05, rw.Spine2.y + 0.086, -0.070 * m), radiusX: 0.030, radiusZ: 0.012, bone: 'Spine2', squareness: 3.0 },
    ];
    const stations = arc.map((st) => ({ ...st, roll: Math.PI / 2 }));
    void thickness;
    return { stations, segments: 8, capStart: true, capEnd: true, capRound: 0.4 };
  });
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

  /** Sleeveless: the band stops at the chest and two straps carry it. */
  top_tank_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.05, 0.010, rig.restWorld.Spine2.y + 0.03),
    ...straps(rig, s, 0.010),
  ], makeClothMaterial({ color, roughness: 0.82, sheen: 0.3 })),

  top_shirt_01: (rig, s, color) => [
    build([
      ...topBody(rig, s, -0.075, 0.014),
      { stations: sleeve(rig, s, 'Left', 7, 0.016), segments: 16, capEnd: true },
      { stations: sleeve(rig, s, 'Right', 7, 0.016), segments: 16, capEnd: true },
      collar(rig, s, { from: -0.03, to: 0.055, thickness: 0.020 }),
    ], makeClothMaterial({ color, roughness: 0.72, sheen: 0.45 })),
    build(
      [placket(rig, s, hipsRef(rig, -0.06), rig.restWorld.Neck.y - 0.02, 0.014)],
      makeClothMaterial({ color, roughness: 0.6, sheen: 0.55 }),
    ),
  ],

  top_knit_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.06, 0.020),
    { stations: ribbed(sleeve(rig, s, 'Left', 7, 0.022), 5, 0.03), segments: 16, capEnd: true },
    { stations: ribbed(sleeve(rig, s, 'Right', 7, 0.022), 5, 0.03), segments: 16, capEnd: true },
    // A turtleneck: tall, and it folds over at the top like the real thing.
    collar(rig, s, { from: -0.04, to: 0.115, thickness: 0.026, flare: 1.1 }),
  ], makeClothMaterial({ color, roughness: 0.95, sheen: 0.2 })),

  top_puffer_01: (rig, s, color) => build([
    ...topBody(rig, s, -0.05, 0.048).map((spec) => quilt(spec, 5, 0.028)),
    { stations: sleeve(rig, s, 'Left', 7, 0.044), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 7, 0.044), segments: 16, capEnd: true },
    collar(rig, s, { from: -0.04, to: 0.05, thickness: 0.05, flare: 1.05 }),
  ], makeClothMaterial({ color, roughness: 0.34, sheen: 0.6, metalness: 0.04 })),

  /** Two-tone on purpose: body one colour, sleeves another. */
  top_varsity_01: (rig, s, color) => [
    build([
      ...topBody(rig, s, -0.065, 0.026),
      collar(rig, s, { from: -0.03, to: 0.048, thickness: 0.030, flare: 1.05 }),
    ], makeClothMaterial({ color, roughness: 0.8, sheen: 0.35 })),
    build([
      { stations: ribbed(sleeve(rig, s, 'Left', 7, 0.028), 3, 0.02), segments: 16, capEnd: true },
      { stations: ribbed(sleeve(rig, s, 'Right', 7, 0.028), 3, 0.02), segments: 16, capEnd: true },
    ], makeClothMaterial({ color: '#e8e4dd', roughness: 0.42, sheen: 0.6, metalness: 0.06 })),
  ],
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

  /** Above the knee: the hem is quoted from the KNEE, not from the ankle. */
  bottom_shorts_01: (rig, s, color) => build(
    trousers(rig, s, (rig.restWorld.LeftLeg.y - rig.restWorld.LeftFoot.y) + 0.06, 0.018, 1.12),
    makeClothMaterial({ color, roughness: 0.86, sheen: 0.24 }),
  ),

  bottom_wide_01: (rig, s, color) => build(
    trousers(rig, s, 0.028, 0.024, 1.42),
    makeClothMaterial({ color, roughness: 0.82, sheen: 0.34 }),
  ),

  /** Skinny and glossy: no flare at all, and the sheen does the talking. */
  bottom_leather_01: (rig, s, color) => build(
    trousers(rig, s, 0.040, 0.010, 0.88),
    makeClothMaterial({ color, roughness: 0.26, sheen: 0.75, metalness: 0.08 }),
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
        // Pleats. Squareness matched to the trunk's own (~2.3): a rounder
        // cone over a squarer body lets the hip poke through on the diagonal,
        // which is a millimetre of skin and a red gate.
        squareness: 2.4,
        scale: 1 + Math.sin(t * 3) * 0.01,
      });
    }
    st.push(...lip(st[st.length - 1], -1, 0.018));
    return build([{ stations: st, segments: 30, capStart: true, capEnd: true, capRound: 0.15 }],
      makeClothMaterial({ color, roughness: 0.8, sheen: 0.36 }));
  },

  bottom_skirtlong_01: (rig, s, color) => {
    const m = s.mass;
    const topY = hipsRef(rig, WAIST_MIN);
    const hemY = rig.restWorld.LeftLeg.y - 0.10;
    const band = torsoBand(rig, s, hipsRef(rig, -0.05), topY, 0.016).slice().reverse();
    const st: Station[] = [...band];
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      st.push({
        pos: V(0, THREE.MathUtils.lerp(hipsRef(rig, -0.05), hemY, t), -0.004),
        // Narrower flare than the mini: a long skirt that opens as fast reads
        // as a lampshade.
        radiusX: (0.16 + t * 0.07) * m,
        radiusZ: (0.125 + t * 0.06) * m,
        bone: 'Hips',
        squareness: 2.4,
        scale: 1 + Math.sin(t * 5) * 0.012,
      });
    }
    st.push(...lip(st[st.length - 1], -1, 0.02));
    return build([{ stations: st, segments: 30, capStart: true, capEnd: true, capRound: 0.12 }],
      makeClothMaterial({ color, roughness: 0.84, sheen: 0.4 }));
  },
};

const shoePair = (rig: BuiltRig, s: BodyShape, chunky: number): GarmentSpec[] => [
  { stations: shoe(rig, s, 'Left', chunky), segments: 16, capStart: true, capEnd: true, capRound: 0.5 },
  { stations: shoe(rig, s, 'Right', chunky), segments: 16, capStart: true, capEnd: true, capRound: 0.5 },
];

/**
 * The sole, as its own slab under the upper. Split out because a sole is never
 * the colour of the shoe above it, and one flat-coloured lump is exactly what
 * made the old pair read as a slipper.
 */
function solePair(rig: BuiltRig, s: BodyShape, thick: number): GarmentSpec[] {
  return (['Left', 'Right'] as const).map((side) => {
    const stations = shoe(rig, s, side, 0.6)
      .filter((st) => st.pos.y < rig.restWorld[`${side}Foot`].y - 0.005)
      .map((st) => ({
        ...st,
        pos: st.pos.clone().add(V(0, -thick * 0.45, 0)),
        radiusX: st.radiusX * 1.02,
        radiusZ: st.radiusZ * 1.02,
        squareness: 3.4,
      }));
    return { stations, segments: 14, capStart: true, capEnd: true, capRound: 0.25 };
  });
}

/** A shaft climbing the ankle, for boots and high-tops. */
function shaftPair(rig: BuiltRig, s: BodyShape, height: number, thickness: number): GarmentSpec[] {
  return (['Left', 'Right'] as const).map((side) => {
    const foot = rig.restWorld[`${side}Foot`];
    const stations = sliceStationsByY(leg(rig, s, side), foot.y + 0.02, foot.y + height)
      .map((st) => clampLegStation({
        ...st,
        pos: st.pos.clone(),
        radiusX: st.radiusX + thickness,
        radiusZ: st.radiusZ + thickness,
        squareness: 2.6,
      }, rig));
    return { stations, segments: 14, capStart: false, capEnd: true, capRound: 0.2 };
  });
}

export const SHOE_BUILDERS: Record<string, Builder> = {
  shoes_sneaker_01: (rig, s, color) => build(shoePair(rig, s, 1.0),
    makeClothMaterial({ color, roughness: 0.66, sheen: 0.3 })),

  shoes_boot_01: (rig, s, color) => build(shoePair(rig, s, 1.8),
    makeClothMaterial({ color, roughness: 0.4, sheen: 0.55 })),

  shoes_glow_01: (rig, s, color) => build(shoePair(rig, s, 1.3),
    makeClothMaterial({ color, roughness: 0.3, sheen: 0.7, emissive: color, emissiveIntensity: 1.6 })),

  /** The silhouette of the last five years: a small upper on a fat sole. */
  shoes_chunky_01: (rig, s, color) => [
    build(shoePair(rig, s, 1.1), makeClothMaterial({ color, roughness: 0.7, sheen: 0.3 })),
    build(solePair(rig, s, 0.052), makeClothMaterial({ color: '#f2efe9', roughness: 0.55, sheen: 0.4 })),
  ],

  shoes_hitop_01: (rig, s, color) => [
    build([...shoePair(rig, s, 1.1), ...shaftPair(rig, s, 0.135, 0.012)],
      makeClothMaterial({ color, roughness: 0.72, sheen: 0.3 })),
    build(solePair(rig, s, 0.030), makeClothMaterial({ color: '#e6e2da', roughness: 0.5, sheen: 0.45 })),
  ],

  shoes_loafer_01: (rig, s, color) => [
    build(shoePair(rig, s, 0.55), makeClothMaterial({ color, roughness: 0.28, sheen: 0.65 })),
    build(solePair(rig, s, 0.016), makeClothMaterial({ color: '#2a221d', roughness: 0.8, sheen: 0.15 })),
  ],

  shoes_heel_01: (rig, s, color) => [
    build(shoePair(rig, s, 0.4), makeClothMaterial({ color, roughness: 0.22, sheen: 0.8 })),
    build(heelPair(rig, s), makeClothMaterial({ color, roughness: 0.22, sheen: 0.8 })),
  ],

  shoes_sandal_01: (rig, s, color) => [
    build(solePair(rig, s, 0.020), makeClothMaterial({ color: '#6b5442', roughness: 0.85, sheen: 0.15 })),
    build(sandalStraps(rig, s), makeClothMaterial({ color, roughness: 0.5, sheen: 0.5 })),
  ],
};

/** The post under the heel. Slim, and it lifts nothing — the foot stays put. */
function heelPair(rig: BuiltRig, s: BodyShape): GarmentSpec[] {
  const t = limbGirth(s);
  return (['Left', 'Right'] as const).map((side) => {
    const foot = rig.restWorld[`${side}Foot`];
    const stations: Station[] = [
      { pos: foot.clone().add(V(0, -0.030, -0.010)), radiusX: 0.026 * t, radiusZ: 0.030 * t, bone: `${side}Foot`, squareness: 2.8 },
      { pos: foot.clone().add(V(0, -0.062, -0.020)), radiusX: 0.014 * t, radiusZ: 0.016 * t, bone: `${side}Foot`, squareness: 2.6 },
      { pos: foot.clone().add(V(0, -0.086, -0.022)), radiusX: 0.017 * t, radiusZ: 0.019 * t, bone: `${side}Foot`, squareness: 3.0 },
    ];
    return { stations, segments: 10, capStart: false, capEnd: true, capRound: 0.2 };
  });
}

/** Two straps over a bare foot: the whole difference between sandal and shoe. */
function sandalStraps(rig: BuiltRig, s: BodyShape): GarmentSpec[] {
  const t = limbGirth(s);
  const out: GarmentSpec[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const foot = rig.restWorld[`${side}Foot`];
    const toe = rig.restWorld[`${side}ToeBase`];
    for (const [p, rx] of [[foot.clone().add(V(0, -0.026, 0.030)), 0.040], [toe.clone().add(V(0, 0.010, 0.030)), 0.036]] as const) {
      const stations: Station[] = [
        { pos: p.clone().add(V(0, 0, -0.030 * t)), radiusX: rx * t, radiusZ: 0.010, bone: `${side}Foot`, squareness: 3.0, roll: Math.PI / 2 },
        { pos: p.clone().add(V(0, 0.012 * t, 0)), radiusX: rx * t, radiusZ: 0.010, bone: `${side}Foot`, squareness: 3.0, roll: Math.PI / 2 },
        { pos: p.clone().add(V(0, 0, 0.030 * t)), radiusX: rx * t, radiusZ: 0.010, bone: `${side}Foot`, squareness: 3.0, roll: Math.PI / 2 },
      ];
      out.push({ stations, segments: 8, capStart: true, capEnd: true, capRound: 0.4 });
    }
  }
  return out;
}

/** Default colourways so the catalogue reads as designed rather than random. */
export const ITEM_COLORS: Record<string, string> = {
  top_tee_01: '#e8e4dd', top_hoodie_01: '#3d4550', top_jacket_01: '#2c3038',
  top_blazer_01: '#242a35', top_holo_01: '#7cd7ff', top_tank_01: '#d9d3c6',
  top_shirt_01: '#5f7fa8', top_knit_01: '#8a6a4e', top_puffer_01: '#c2452f',
  top_varsity_01: '#2f3b57',

  bottom_jeans_01: '#3f5570', bottom_cargo_01: '#6a6350', bottom_track_01: '#22242a',
  bottom_skirt_01: '#8a3f54', bottom_shorts_01: '#8c8474', bottom_wide_01: '#4a4f5c',
  bottom_leather_01: '#1c1a1c', bottom_skirtlong_01: '#3d5a4a',

  shoes_sneaker_01: '#f0eeea', shoes_boot_01: '#241f1c', shoes_glow_01: '#39d98a',
  shoes_chunky_01: '#d8d2c6', shoes_hitop_01: '#b03a3a', shoes_loafer_01: '#3a2a20',
  shoes_heel_01: '#7a2438', shoes_sandal_01: '#c9a06a',

  acc_glasses_01: '#3a3f48', acc_shades_01: '#14161c', acc_cap_01: '#2f3b57',
  acc_beanie_01: '#7a4a52', acc_headset_01: '#2a2e36', acc_earrings_01: '#ffc247',
  acc_chain_01: '#ffc247', acc_scarf_01: '#9c4a3c', acc_mask_01: '#22252c',
  acc_halo_01: '#ffd76a',
};
