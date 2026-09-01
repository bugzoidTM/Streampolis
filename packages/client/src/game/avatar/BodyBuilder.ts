import * as THREE from 'three';
import { loft, assemble, type Station } from './Loft.js';
import type { BoneName, BuiltRig } from './Skeleton.js';

/**
 * Minimum daylight, in metres, that the silhouette keeps between the two legs
 * below the knee — and therefore between the two shoes. The rubric asks for a
 * character that stays readable at 60 px; at 1.67 m that is roughly 3 cm of
 * real gap before the two limbs merge into one blob on screen.
 */
export const LEG_GAP = 0.036;

/**
 * Generates the avatar body mesh from the rig's rest pose. Everything is
 * lofted from elliptical cross-sections, which gives a stylised semi-cartoon
 * silhouette (SPECs §4) at a predictable, low triangle count and with no
 * external mesh download.
 */

export interface BodyShape {
  /** Overall soft-tissue multiplier; >1 is a fuller build. */
  mass: number;
  /** Chest/bust depth added at the Spine2 station. */
  chest: number;
  /** Waist narrowing; <1 cinches. */
  waist: number;
  hips: number;
  shoulders: number;
  /** Limb thickness independent of torso mass. */
  limbs: number;
}

/**
 * Baseline mass sits above 1.0 because the first pass produced a figure that
 * measured correctly but read as a wire mannequin: at this height the volumes
 * need roughly 12% more girth before the silhouette holds up.
 */
export const BODY_PRESETS: BodyShape[] = [
  { mass: 1.12, chest: 1.0,  waist: 1.0,  hips: 1.0,  shoulders: 1.0,  limbs: 1.14 },
  { mass: 1.28, chest: 1.06, waist: 1.18, hips: 1.1,  shoulders: 1.08, limbs: 1.28 },
  { mass: 1.01, chest: 1.04, waist: 0.88, hips: 1.06, shoulders: 0.93, limbs: 1.03 },
  { mass: 1.18, chest: 1.16, waist: 0.94, hips: 1.12, shoulders: 0.96, limbs: 1.12 },
];

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Limb girth multiplier. `limbs * mass` compounded the two sliders, so the
 * heaviest preset ended up with a knee wider than its own head and thighs
 * that could never separate. Mass still reads on the limbs, at half weight.
 */
export function limbGirth(s: BodyShape): number {
  return s.limbs * (1 + (s.mass - 1) * 0.5);
}

/**
 * How far from the body's mid-plane a leg surface may reach at a given height:
 * zero at the crotch, where the thighs genuinely meet, opening to half of
 * {@link LEG_GAP} by the knee and staying there down to the sole. Body and
 * garment both clamp against this, so a trouser leg cannot fill in the gap the
 * body just opened.
 */
export function legInnerLimit(rig: BuiltRig, y: number, gap = LEG_GAP): number {
  const h = rig.proportions.height;
  const crotch = rig.restWorld.Hips.y - 0.105 * h;
  const knee = rig.restWorld.LeftLeg.y;
  // 1 at the crotch, 0 at the knee and below.
  const t = THREE.MathUtils.smoothstep(y, knee, crotch);
  return (gap / 2) * (1 - t);
}

/** Narrows a station so its inner face respects {@link legInnerLimit}. */
export function clampLegStation(st: Station, rig: BuiltRig, gap = LEG_GAP): Station {
  const maxR = Math.abs(st.pos.x) - legInnerLimit(rig, st.pos.y, gap);
  if (maxR <= 0.004 || st.radiusX <= maxR) return st;
  return { ...st, pos: st.pos.clone(), radiusX: maxR };
}

/** Point on the line between two bones' rest positions. */
function between(rig: BuiltRig, a: BoneName, b: BoneName, t: number, offset?: THREE.Vector3) {
  const p = new THREE.Vector3().lerpVectors(rig.restWorld[a], rig.restWorld[b], t);
  if (offset) p.add(offset);
  return p;
}

export interface BodyParts {
  /** Torso, neck, arms, legs — one merged skinned geometry. */
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  /** Local-space anchor for eyes/brows, in head-bone space. */
  headHeight: number;
}

/**
 * The torso profile, station by station, laid out on real landmarks rather
 * than on even divisions of the spine: the narrowest ring has to sit above the
 * iliac crest and below the lowest rib, otherwise the trunk reads as a slab no
 * matter how the radii are tuned. Section centres also drift in Z — glutes
 * back, belly and chest forward — because a body's silhouette from the side is
 * an S, not a column.
 */
export function torso(rig: BuiltRig, s: BodyShape): Station[] {
  const m = s.mass;
  const rw = rig.restWorld;
  const h = rig.proportions.height;
  // Offsets are quoted for the nominal 1.72 m rig and scale with it; anchoring
  // on the bones keeps the profile correct for the long/short-torso presets.
  const hip = (d: number) => rw.Hips.y + d * h;
  const sp = (d: number) => rw.Spine.y + d * h;
  const sp1 = (d: number) => rw.Spine1.y + d * h;
  const sp2 = (d: number) => rw.Spine2.y + d * h;

  return [
    // Pelvic floor. Near-point so the domed cap is swallowed by the thighs;
    // a wide ring here is what produced the flat plate between the legs.
    { pos: V(0, hip(-0.157), -0.004), radiusX: 0.040 * m, radiusZ: 0.044 * m, bone: 'Hips', squareness: 2.1 },
    { pos: V(0, hip(-0.129), -0.008), radiusX: 0.086 * m * s.hips, radiusZ: 0.078 * m, bone: 'Hips', squareness: 2.1 },
    // Glute fold: the deepest point front-to-back on the whole trunk.
    { pos: V(0, hip(-0.089), -0.014), radiusX: 0.132 * m * s.hips, radiusZ: 0.100 * m, bone: 'Hips', squareness: 2.2 },
    // The widest ring below the chest, and it has to be: the trochanter is
    // the widest point of a real body, and a pelvis narrower than the top of
    // its own thigh leaves a wedge of bare skin on each hip that no garment
    // lofted from the trunk can cover.
    { pos: V(0, hip(-0.043), -0.012), radiusX: 0.150 * m * s.hips, radiusZ: 0.106 * m, bone: 'Hips', squareness: 2.3 },
    { pos: V(0, hip(0.009), -0.004), radiusX: 0.140 * m * s.hips, radiusZ: 0.100 * m, bone: 'Hips', blendBone: 'Spine', blendWeight: 0.4, squareness: 2.2 },
    // Waist. Narrowest ring of the trunk, and noticeably shallower than it is
    // wide — a circular waist is the single tell of a lofted mannequin.
    { pos: V(0, sp(-0.025), 0.002), radiusX: 0.114 * m * s.waist, radiusZ: 0.085 * m * s.waist, bone: 'Spine', blendBone: 'Hips', blendWeight: 0.25, squareness: 2.15 },
    { pos: V(0, sp(0.021), 0.004), radiusX: 0.111 * m * s.waist, radiusZ: 0.084 * m * s.waist, bone: 'Spine', blendBone: 'Spine1', blendWeight: 0.4, squareness: 2.15 },
    // Lower ribs flare back out.
    { pos: V(0, sp1(-0.033), 0.006), radiusX: 0.128 * m, radiusZ: 0.095 * m, bone: 'Spine1', blendBone: 'Spine2', blendWeight: 0.3, squareness: 2.2 },
    { pos: V(0, sp1(0.035), 0.008), radiusX: 0.146 * m * s.chest, radiusZ: 0.106 * m * s.chest, bone: 'Spine1', blendBone: 'Spine2', blendWeight: 0.5, squareness: 2.3 },
    // Chest.
    { pos: V(0, sp2(-0.023), 0.010), radiusX: 0.152 * m * s.chest, radiusZ: 0.104 * m * s.chest, bone: 'Spine2', squareness: 2.3 },
    { pos: V(0, sp2(0.037), 0.002), radiusX: 0.152 * m * s.shoulders, radiusZ: 0.096 * m, bone: 'Spine2', squareness: 2.3 },
    // Acromion shelf: the widest ring of the whole trunk, and the flattest.
    // It has to reach the arm socket. The shelf that used to sit here stopped
    // 5 mm short of the deltoid and then collapsed into the neck below the
    // joint, so the arm ended as a stump with daylight behind it — the
    // loudest articulated-doll tell the figure had.
    // Mass counts for less here than anywhere else on the trunk: at full
    // weight the heavy preset grew a 42 cm shoulder shelf and read as armour.
    { pos: V(0, sp2(0.090), -0.006), radiusX: 0.150 * (1 + (m - 1) * 0.55) * s.shoulders, radiusZ: 0.082 * m, bone: 'Spine2', squareness: 2.7 },
    // Trapezius: the slope from that shelf into the neck. Three rings, because
    // one straight line from shoulder to neck reads as a coat hanger and two
    // read as a funnel.
    { pos: V(0, sp2(0.118), -0.008), radiusX: 0.112 * (1 + (m - 1) * 0.55) * s.shoulders, radiusZ: 0.078 * m, bone: 'Spine2', blendBone: 'Neck', blendWeight: 0.3, squareness: 2.35 },
    // The trunk stops NARROWER than the neck it meets, so a throat comes out
    // of it. Ending wider swallowed 4 cm of neck and sat the head on the
    // chest, which is most of why the figure read as hunched.
    { pos: V(0, sp2(0.142), -0.008), radiusX: 0.052 * m, radiusZ: 0.050 * m, bone: 'Spine2', blendBone: 'Neck', blendWeight: 0.6, squareness: 2.1 },
  ];
}

export function neck(rig: BuiltRig, s: BodyShape): Station[] {
  const rw = rig.restWorld;
  const r = 0.055 * s.mass;
  return [
    { pos: V(0, rw.Neck.y - 0.03, -0.002), radiusX: r * 1.22, radiusZ: r * 1.18, bone: 'Neck', blendBone: 'Spine2', blendWeight: 0.5 },
    { pos: V(0, rw.Neck.y + 0.03, 0.004),  radiusX: r * 1.02, radiusZ: r * 1.0, bone: 'Neck' },
    { pos: V(0, rw.Head.y - 0.005, 0.01),  radiusX: r * 1.0,  radiusZ: r * 0.98, bone: 'Head', blendBone: 'Neck', blendWeight: 0.35 },
  ];
}

/**
 * Named cuts into the chain {@link arm} returns, so a sleeve asks for "the
 * elbow" instead of for station 5. The chain grew four stations at the
 * shoulder once already; every garment that had memorised an index came out
 * of that change one station short.
 */
const ARM_SHOULDER_STATIONS = 6;
export const ARM_CUT = {
  shoulder: ARM_SHOULDER_STATIONS - 1,
  biceps: ARM_SHOULDER_STATIONS,
  elbow: ARM_SHOULDER_STATIONS + 2,
  wrist: ARM_SHOULDER_STATIONS + 4,
} as const;

export function arm(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right'): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = limbGirth(s);
  const sign = side === 'Left' ? 1 : -1;

  const ax = Math.abs(rw[L('Arm')].x);
  const ay = rw[L('Arm')].y;

  return [
    // The chain starts INSIDE the trunk, under the trapezius, and sweeps out
    // over the acromion before it turns down the arm.
    //
    // It used to start on top of the joint with a domed cap of its own. That
    // gave the deltoid a rounded stump 2 cm ABOVE the shoulder line with
    // daylight between it and the ribcage: the arm read as a separate tube
    // hung off a torso, which is the whole "articulated doll" complaint. A
    // shoulder is not a joint you can see — it is a surface that runs from
    // the neck to the elbow without a seam.
    // The centres DESCEND as they go out, so the top of this tube traces the
    // shoulder line instead of crossing it. A tube of constant height from
    // neck to joint puts the top of the deltoid 3 cm ABOVE the trapezius that
    // is supposed to meet it, and the shoulder gets a dip and then a bump —
    // the hard crease the nude figure had running over each deltoid.
    //
    // The rings are square to the path, so a station with a steep tangent
    // tilts and throws its own radius upward. Keeping the slope gentle here is
    // what stops the shoulder pad every top in the catalogue used to grow.
    { pos: V(sign * ax * 0.30, ay - 0.030, 0.004), radiusX: 0.060 * t, radiusZ: 0.056 * t, bone: 'Spine2', squareness: 2.4 },
    { pos: V(sign * ax * 0.62, ay - 0.042, 0.003), radiusX: 0.062 * t, radiusZ: 0.058 * t, bone: 'Spine2', blendBone: L('Arm'), blendWeight: 0.3, squareness: 2.3 },
    { pos: V(sign * ax * 0.86, ay - 0.056, 0.001), radiusX: 0.063 * t, radiusZ: 0.059 * t, bone: 'Spine2', blendBone: L('Arm'), blendWeight: 0.55, squareness: 2.2 },
    // Acromion.
    { pos: V(sign * ax * 0.99, ay - 0.070, 0), radiusX: 0.062 * t, radiusZ: 0.058 * t, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.5 },
    // Deltoid belly, then the turn down the arm.
    { pos: V(sign * ax * 1.04, ay - 0.104, 0), radiusX: 0.060 * t, radiusZ: 0.057 * t, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.25 },
    { pos: V(sign * ax * 1.02, ay - 0.132, 0), radiusX: 0.057 * t, radiusZ: 0.054 * t, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.14 },
    // Biceps swell.
    { pos: between(rig, L('Arm'), L('ForeArm'), 0.38), radiusX: 0.05 * t, radiusZ: 0.049 * t, bone: L('Arm') },
    { pos: between(rig, L('Arm'), L('ForeArm'), 0.86), radiusX: 0.042 * t, radiusZ: 0.041 * t, bone: L('Arm'), blendBone: L('ForeArm'), blendWeight: 0.35 },
    // Elbow.
    { pos: rw[L('ForeArm')].clone(), radiusX: 0.041 * t, radiusZ: 0.042 * t, bone: L('ForeArm'), blendBone: L('Arm'), blendWeight: 0.4 },
    { pos: between(rig, L('ForeArm'), L('Hand'), 0.3), radiusX: 0.043 * t, radiusZ: 0.04 * t, bone: L('ForeArm') },
    // Wrist — flattened, which is what makes a forearm read as a forearm.
    { pos: between(rig, L('ForeArm'), L('Hand'), 0.92), radiusX: 0.024 * t, radiusZ: 0.031 * t, bone: L('ForeArm'), blendBone: L('Hand'), blendWeight: 0.4 },
    // The chain stops at the base of the palm. Everything past the wrist is
    // built by hand() as separate digits.
    //
    // Flat across Z, not across X: an arm at rest hangs with the palm against
    // the thigh, so the wide axis of the wrist runs front to back.
    { pos: rw[L('Hand')].clone().add(V(0, -0.012, 0)), radiusX: 0.020 * t, radiusZ: 0.032 * t, bone: L('Hand'), squareness: 2.6 },
  ];
}

/**
 * A hand: palm, four fingers and a thumb.
 *
 * The old one was a single soft volume that the code itself called a mitten.
 * Five digits is not detail for its own sake — wave, clap, the heart gesture,
 * reacting to a gift and every selfie pose in the product are made of fingers,
 * and a mitten can only ever mime them.
 *
 * Every digit skins to the Hand bone, so they move as one piece: the rig has
 * no finger joints and inventing them would retarget every clip. What this
 * buys is silhouette, and silhouette is the whole complaint.
 */
export function hand(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right'): Station[][] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = limbGirth(s);
  const bone = L('Hand');
  const sign = side === 'Left' ? 1 : -1;

  const wrist = rw[bone].clone().add(V(0, -0.010, 0));
  const knuckles = rw[bone].clone().add(V(0, -0.078 * t, 0.004));
  const at = (u: number) => new THREE.Vector3().lerpVectors(wrist, knuckles, u);

  // Palm: wide across the knuckles, thin through the palm. That flatness is
  // most of what separates a hand from the end of an arm.
  //
  // The whole hand is turned a quarter: the knuckles run front to back and the
  // palm faces the thigh, which is how an arm hangs. Built facing forward it
  // presented the flat of the palm to the camera with the fingers fanned like
  // a plate — and the curl below, the one thing that says "relaxed", pointed
  // straight at the lens where it foreshortened into nothing.
  const palm: Station[] = [
    { pos: wrist, radiusX: 0.020 * t, radiusZ: 0.032 * t, bone, blendBone: L('ForeArm'), blendWeight: 0.35, squareness: 2.7 },
    { pos: at(0.5), radiusX: 0.021 * t, radiusZ: 0.038 * t, bone, squareness: 3.0 },
    { pos: knuckles, radiusX: 0.018 * t, radiusZ: 0.039 * t, bone, squareness: 3.2 },
  ];

  const out: Station[][] = [palm];

  // Spacing under one diameter, so the fingers touch at the knuckle and part
  // toward the tips. Splayed digits read as a rubber glove. `z` runs front to
  // back: the index finger is the forward one, on both hands.
  const FINGERS = [
    { z:  0.025, len: 0.058, r: 0.0112 },
    { z:  0.0085, len: 0.064, r: 0.0116 },
    { z: -0.0085, len: 0.059, r: 0.0106 },
    { z: -0.025, len: 0.046, r: 0.0092 },
  ];

  for (const f of FINGERS) {
    const base = knuckles.clone().add(V(0, 0.005 * t, f.z * t));
    const st: Station[] = [];
    for (let i = 0; i <= 3; i++) {
      const u = i / 3;
      // A relaxed hand curls INWARD, toward the thigh. Straight fingers read
      // as a salute, and the avatar spends most of its life standing still.
      const curl = Math.pow(u, 1.5) * 0.58;
      st.push({
        pos: base.clone().add(V(
          -sign * f.len * t * curl,
          -f.len * t * u,
          f.z * t * u * 0.20,
        )),
        radiusX: f.r * t * 0.94 * (1 - u * 0.26),
        radiusZ: f.r * t * (1 - u * 0.30),
        bone,
        squareness: 2.3,
      });
    }
    out.push(st);
  }

  // Thumb: off the FRONT of the palm, swinging in and down — the one digit
  // that does not share the plane of the others, which is why it reads.
  const thumbBase = at(0.34).add(V(-sign * 0.004 * t, 0, 0.022 * t));
  const thumb: Station[] = [];
  for (let i = 0; i <= 3; i++) {
    const u = i / 3;
    thumb.push({
      pos: thumbBase.clone().add(V(
        -sign * (0.024 + 0.038 * u) * t * u,
        -0.034 * t * u,
        0.014 * t * u,
      )),
      radiusX: 0.014 * t * (1 - u * 0.26),
      radiusZ: 0.015 * t * (1 - u * 0.32),
      bone,
      squareness: 2.4,
    });
  }
  out.push(thumb);

  return out;
}

export function leg(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right'): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = limbGirth(s);

  const stations: Station[] = [
    // The top of the thigh tucks UNDER the pelvis rather than standing proud
    // of it. It used to reach 6 cm past the widest ring of the trunk, which is
    // a saddlebag no trouser cut has ever had.
    { pos: rw[L('UpLeg')].clone().add(V(0, 0.038, 0)), radiusX: 0.074 * t * s.hips, radiusZ: 0.084 * t, bone: L('UpLeg'), blendBone: 'Hips', blendWeight: 0.55 },
    { pos: rw[L('UpLeg')].clone().add(V(0, -0.01, 0)), radiusX: 0.080 * t, radiusZ: 0.088 * t, bone: L('UpLeg'), blendBone: 'Hips', blendWeight: 0.2 },
    // Thigh mass sits high; the taper toward the knee is what reads as a leg.
    { pos: between(rig, L('UpLeg'), L('Leg'), 0.35), radiusX: 0.079 * t, radiusZ: 0.084 * t, bone: L('UpLeg') },
    { pos: between(rig, L('UpLeg'), L('Leg'), 0.85), radiusX: 0.057 * t, radiusZ: 0.064 * t, bone: L('UpLeg'), blendBone: L('Leg'), blendWeight: 0.35 },
    { pos: rw[L('Leg')].clone(), radiusX: 0.052 * t, radiusZ: 0.060 * t, bone: L('Leg'), blendBone: L('UpLeg'), blendWeight: 0.4, squareness: 2.3 },
    // Calf. Deeper than it is wide — that asymmetry is most of what separates
    // a leg from a post, and it is also what buys the gap between the shins.
    { pos: between(rig, L('Leg'), L('Foot'), 0.28), radiusX: 0.055 * t, radiusZ: 0.067 * t, bone: L('Leg') },
    { pos: between(rig, L('Leg'), L('Foot'), 0.66), radiusX: 0.042 * t, radiusZ: 0.049 * t, bone: L('Leg') },
    // Ankle.
    { pos: rw[L('Foot')].clone().add(V(0, 0.012, 0)), radiusX: 0.032 * t, radiusZ: 0.038 * t, bone: L('Foot'), blendBone: L('Leg'), blendWeight: 0.4 },
    { pos: rw[L('Foot')].clone().add(V(0, -0.03, 0.012)), radiusX: 0.035 * t, radiusZ: 0.05 * t, bone: L('Foot'), squareness: 2.6 },
    // Foot volume, swept forward toward the toe.
    { pos: rw[L('Foot')].clone().add(V(0, -0.052, 0.07)), radiusX: 0.037 * t, radiusZ: 0.06 * t, bone: L('Foot'), squareness: 3.0 },
    { pos: rw[L('ToeBase')].clone().add(V(0, 0.016, 0.03)), radiusX: 0.035 * t, radiusZ: 0.045 * t, bone: L('ToeBase'), blendBone: L('Foot'), blendWeight: 0.45, squareness: 3.0 },
    { pos: rw[L('ToeBase')].clone().add(V(0, 0.014, 0.058)), radiusX: 0.023 * t, radiusZ: 0.022 * t, bone: L('ToeBase'), squareness: 2.6 },
  ];
  return stations.map((st) => clampLegStation(st, rig));
}

/**
 * Sculpts the head from a UV sphere. The deformations are all analytic
 * functions of the unit-sphere position, which keeps the result symmetric and
 * lets face presets be a handful of scalars rather than blend-shape data.
 */
export interface FaceShape {
  /** Vertical squash of the cranium; <1 is a rounder skull. */
  cranium: number;
  /** Jaw width at the chin. */
  jaw: number;
  /** How far the chin projects forward. */
  chin: number;
  /** Cheekbone prominence. */
  cheeks: number;
  /** Overall head scale relative to the rig. */
  scale: number;
  /** Brow ridge depth. */
  brow: number;
}

export const FACE_PRESETS: FaceShape[] = [
  { cranium: 1.0,  jaw: 1.0,  chin: 1.0,  cheeks: 1.0,  scale: 1.0,  brow: 1.0 },
  { cranium: 0.97, jaw: 1.12, chin: 1.14, cheeks: 0.94, scale: 1.02, brow: 1.18 },
  { cranium: 1.03, jaw: 0.9,  chin: 0.88, cheeks: 1.12, scale: 0.98, brow: 0.86 },
  { cranium: 1.0,  jaw: 1.04, chin: 0.96, cheeks: 1.06, scale: 1.04, brow: 1.0 },
];

/** Radius of the head sphere before sculpting, for a rig and a face preset. */
export function headRadius(rig: BuiltRig, face: FaceShape): number {
  return 0.128 * face.scale * rig.proportions.headScale * rig.proportions.height;
}

/** Where the crown sits in Head-bone local space. */
export function headCentre(rig: BuiltRig, face: FaceShape): THREE.Vector3 {
  return new THREE.Vector3(0, headRadius(rig, face) * 0.42, 0.008);
}

/**
 * The skull, as a pure function of a direction on the unit sphere. Both the
 * head mesh and everything that has to SIT on the head — nose, ears, brows,
 * lashes, hair — call this, so a feature can never float a millimetre off the
 * surface it is supposed to be part of.
 *
 * Jaw and cheek carry more of the shape than they used to: a face reads first
 * by its outline, and a round skull with features painted on it still reads as
 * an egg.
 */
export function sculptHead(n: THREE.Vector3, R: number, face: FaceShape, out = new THREE.Vector3()): THREE.Vector3 {
  // Normalised vertical coordinate: -1 at the chin, +1 at the crown.
  const t = n.y;
  // Front-facing weight, so deformations only act on the face side.
  const front = Math.max(0, n.z);

  // Width : depth : height. A real head is roughly 0.65 : 0.87 : 1, and the
  // sculpt used to be 0.9 : 0.94 : 1 — a ball. That single ratio is why the
  // face read as a small mask painted on a balloon: seen from three quarters
  // the cranium filled the frame and the features had nowhere to be. Wider
  // than life on purpose, because the style asks for it, but nowhere near
  // round.
  let sx = 0.69, sy = 0.99, sz = 0.86;

  // Horizontal sections are SUPERELLIPTICAL, not circular. A skull is flat at
  // the temples and flat down the sides of the jaw, and round only at the
  // forehead and the occiput; a circular section is an egg, and no amount of
  // nose, lip and brow rescues an egg — that was the single loudest thing
  // left in the face. Strongest through the cranium and the mandible, and
  // released at the crown and the chin, where a head really is round.
  const rho = Math.hypot(n.x, n.z);
  if (rho > 1e-4) {
    const cx = Math.abs(n.x) / rho;
    const cz = Math.abs(n.z) / rho;
    const e = THREE.MathUtils.lerp(2, 2.45, Math.exp(-Math.pow((t - 0.14) / 0.60, 2)));
    const k = 1 / Math.pow(Math.pow(cx, e) + Math.pow(cz, e), 1 / e);
    sx *= k;
    sz *= k;
  }

  // Cranium, flattened at the top. The crown used to rise ABOVE a full sphere,
  // which put the eye line at 58% of the head's height instead of the 50% a
  // face is read at — the whole face sat too low under too much forehead.
  sy *= THREE.MathUtils.lerp(1.0, 0.93 * face.cranium, Math.max(0, t));

  // Jaw taper: below the ear line the head narrows toward the chin. It holds
  // its width to the jaw angle and then goes, rather than tapering from the
  // ears down — a continuous taper IS the egg.
  const below = Math.max(0, -t);
  const jawTaper = THREE.MathUtils.lerp(1.0, 0.60 / face.jaw, Math.pow(below, 1.9));
  sx *= jawTaper;
  sz *= THREE.MathUtils.lerp(1.0, 0.88, Math.pow(below, 1.7));

  out.set(n.x * R * sx, n.y * R * sy, n.z * R * sz);

  // Occiput. The back of a head is not a hemisphere: it carries a bulge above
  // the nape, and in profile that bulge is most of what says "skull".
  const occiput = Math.exp(-Math.pow((t - 0.20) / 0.30, 2)) * Math.max(0, -n.z);
  out.z -= occiput * R * 0.050;

  // Chin projection.
  const chinMask = Math.pow(below, 1.8) * front;
  out.z += chinMask * R * 0.16 * face.chin;
  out.y -= chinMask * R * 0.06;

  // The mandible line: a ridge running from below the ear to the chin. It is
  // what gives a profile a jaw instead of a curve.
  const jawMask = Math.exp(-Math.pow((t + 0.36) / 0.15, 2)) * Math.pow(Math.abs(n.x), 0.7)
    * Math.max(0, 0.30 + 0.70 * front);
  out.x += Math.sign(n.x) * jawMask * R * 0.085 * face.jaw;
  out.y += jawMask * R * 0.016;

  // The jaw ANGLE, under and behind the ear, where the mandible turns up. A
  // mandible line that only exists at the front is a chin with no hinge, and
  // the head goes back to reading as an oval seen from three quarters.
  const gonion = Math.exp(-Math.pow((t + 0.30) / 0.12, 2))
    * Math.exp(-Math.pow((n.z + 0.15) / 0.36, 2)) * Math.pow(Math.abs(n.x), 1.2);
  out.x += Math.sign(n.x) * gonion * R * 0.040 * face.jaw;
  out.y -= gonion * R * 0.016;

  // Brow ridge just above the eye line.
  const browMask = Math.exp(-Math.pow((t - 0.16) / 0.11, 2)) * front;
  out.z += browMask * R * 0.05 * face.brow;

  // Cheekbones.
  const cheekMask = Math.exp(-Math.pow((t + 0.02) / 0.16, 2)) * front * Math.abs(n.x);
  out.z += cheekMask * R * 0.05 * face.cheeks;
  out.x += Math.sign(n.x) * cheekMask * R * 0.055 * face.cheeks;

  // The hollow under the cheekbone. Without it the cheek is a ball, and the
  // whole face reads younger and blanker than any preset intends.
  const hollowMask = Math.exp(-Math.pow((t + 0.22) / 0.1, 2))
    * Math.exp(-Math.pow((Math.abs(n.x) - 0.5) / 0.22, 2)) * front;
  out.z -= hollowMask * R * 0.03;

  // Eye sockets: a shallow recess so the eyeballs sit inside the head.
  const socketMask = Math.exp(-Math.pow((t - 0.06) / 0.075, 2))
    * Math.exp(-Math.pow((Math.abs(n.x) - 0.36) / 0.2, 2)) * front;
  out.z -= socketMask * R * 0.055;

  // The nose is modelled as its own geometry now; the skull keeps only the
  // bridge it grows from, which is what stops a seam at the glabella.
  const bridgeMask = Math.exp(-Math.pow((t - 0.02) / 0.16, 2))
    * Math.exp(-Math.pow(n.x / 0.1, 2)) * Math.pow(front, 2);
  out.z += bridgeMask * R * 0.055;

  // Philtrum shelf above the lip and the soft roll below it.
  const lipMask = Math.exp(-Math.pow((t + 0.32) / 0.09, 2))
    * Math.exp(-Math.pow(n.x / 0.3, 2)) * front;
  out.z += lipMask * R * 0.035;

  return out;
}

/**
 * A point on the sculpted skull for a direction, optionally lifted off it by
 * `lift` head-radii. Everything that has to sit ON the head — feature, lash,
 * hair cap, lock — goes through here, which is what makes it impossible for a
 * part to float off the skull when a face preset reshapes it.
 */
export function skullPoint(
  dir: THREE.Vector3,
  R: number,
  face: FaceShape,
  lift = 0,
): THREE.Vector3 {
  const n = dir.clone().normalize();
  const p = sculptHead(n, R, face);
  return lift ? p.addScaledVector(n, lift * R) : p;
}

export function buildHead(rig: BuiltRig, face: FaceShape, headBoneIndex: number): THREE.BufferGeometry {
  const R = headRadius(rig, face);
  const geo = new THREE.SphereGeometry(R, 48, 36);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    sculptHead(n, R, face, v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }

  geo.computeVertexNormals();
  // Head rides entirely on the Head bone; the neck loft handles the blend.
  const count = pos.count;
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    si[i * 4] = headBoneIndex;
    sw[i * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setAttribute('uv1', geo.attributes.uv.clone());

  // Lift into world rest position (the sphere is built around the origin).
  const c = headCentre(rig, face);
  geo.translate(0, rig.restWorld.Head.y + c.y, c.z);
  return geo;
}

export function buildBody(rig: BuiltRig, shape: BodyShape, segments = 20): THREE.BufferGeometry {
  const sub = 2;
  const parts = [
    loft(torso(rig, shape), { segments, capStart: true, capEnd: false, subdivisions: sub, uvOffset: [0, 0], uvScale: [0.5, 0.5] }),
    loft(neck(rig, shape), { segments: Math.round(segments * 0.7), capStart: false, capEnd: true, subdivisions: sub, uvOffset: [0.5, 0], uvScale: [0.25, 0.2] }),
    // No end cap on the arm: the palm closes it. A domed cap there pushed a
    // hard ring of skin out through the back of the hand. The START cap is
    // nearly flat because the chain now begins inside the ribcage, and a 5 cm
    // dome there is 5 cm of geometry nobody will ever see.
    loft(arm(rig, shape, 'Left'), { segments: Math.round(segments * 0.8), capStart: true, capEnd: false, capRound: 0.2, subdivisions: sub, uvOffset: [0, 0.5], uvScale: [0.25, 0.5] }),
    loft(arm(rig, shape, 'Right'), { segments: Math.round(segments * 0.8), capStart: true, capEnd: false, capRound: 0.2, subdivisions: sub, uvOffset: [0.25, 0.5], uvScale: [0.25, 0.5] }),
    loft(leg(rig, shape, 'Left'), { segments: Math.round(segments * 0.9), capStart: true, capEnd: true, subdivisions: sub, uvOffset: [0.5, 0.5], uvScale: [0.25, 0.5] }),
    loft(leg(rig, shape, 'Right'), { segments: Math.round(segments * 0.9), capStart: true, capEnd: true, subdivisions: sub, uvOffset: [0.75, 0.5], uvScale: [0.25, 0.5] }),
  ];

  // Digits are small and numerous, so they get a coarser ring than a limb;
  // at this scale the cost is all in the ring count, not in the count of parts.
  for (const side of ['Left', 'Right'] as const) {
    const uvx = side === 'Left' ? 0.5 : 0.75;
    hand(rig, shape, side).forEach((stations, i) => {
      parts.push(loft(stations, {
        segments: i === 0 ? Math.round(segments * 0.6) : 8,
        capStart: true, capEnd: true, capRound: i === 0 ? 0.35 : 0.9,
        subdivisions: 2,
        uvOffset: [uvx, 0.2], uvScale: [0.25, 0.3],
      }));
    });
  }

  return assemble(parts);
}
