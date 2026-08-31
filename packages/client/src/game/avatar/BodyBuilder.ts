import * as THREE from 'three';
import { loft, assemble, type Station } from './Loft.js';
import type { BoneName, BuiltRig } from './Skeleton.js';

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
function torso(rig: BuiltRig, s: BodyShape): Station[] {
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
    { pos: V(0, hip(-0.089), -0.014), radiusX: 0.124 * m * s.hips, radiusZ: 0.098 * m, bone: 'Hips', squareness: 2.2 },
    { pos: V(0, hip(-0.043), -0.012), radiusX: 0.138 * m * s.hips, radiusZ: 0.104 * m, bone: 'Hips', squareness: 2.3 },
    { pos: V(0, hip(0.009), -0.004), radiusX: 0.130 * m * s.hips, radiusZ: 0.098 * m, bone: 'Hips', blendBone: 'Spine', blendWeight: 0.4, squareness: 2.2 },
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
    // Clavicle shelf, then a fast taper into the neck. That taper is the
    // trapezius slope; without it the shoulders read as a coat hanger.
    { pos: V(0, sp2(0.083), -0.006), radiusX: 0.140 * m * s.shoulders, radiusZ: 0.086 * m, bone: 'Spine2', squareness: 2.2 },
    { pos: V(0, sp2(0.117), -0.008), radiusX: 0.086 * m, radiusZ: 0.070 * m, bone: 'Spine2', blendBone: 'Neck', blendWeight: 0.45, squareness: 2.1 },
  ];
}

function neck(rig: BuiltRig, s: BodyShape): Station[] {
  const rw = rig.restWorld;
  const r = 0.055 * s.mass;
  return [
    { pos: V(0, rw.Neck.y - 0.03, -0.002), radiusX: r * 1.35, radiusZ: r * 1.3, bone: 'Neck', blendBone: 'Spine2', blendWeight: 0.5 },
    { pos: V(0, rw.Neck.y + 0.03, 0.004),  radiusX: r * 1.02, radiusZ: r * 1.0, bone: 'Neck' },
    { pos: V(0, rw.Head.y - 0.005, 0.01),  radiusX: r * 1.0,  radiusZ: r * 0.98, bone: 'Head', blendBone: 'Neck', blendWeight: 0.35 },
  ];
}

function arm(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right'): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = s.limbs * s.mass;
  const sign = side === 'Left' ? 1 : -1;

  return [
    // Deltoid cap, pushed outward so it merges into the clavicle shelf.
    { pos: rw[L('Arm')].clone().add(V(sign * 0.006, 0.042, 0)), radiusX: 0.052 * t, radiusZ: 0.052 * t, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.6 },
    { pos: rw[L('Arm')].clone().add(V(0, 0.018, 0)), radiusX: 0.062 * t, radiusZ: 0.061 * t, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.4 },
    { pos: rw[L('Arm')].clone().add(V(0, -0.005, 0)), radiusX: 0.058 * t, radiusZ: 0.057 * t, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.18 },
    // Biceps swell.
    { pos: between(rig, L('Arm'), L('ForeArm'), 0.38), radiusX: 0.05 * t, radiusZ: 0.049 * t, bone: L('Arm') },
    { pos: between(rig, L('Arm'), L('ForeArm'), 0.86), radiusX: 0.042 * t, radiusZ: 0.041 * t, bone: L('Arm'), blendBone: L('ForeArm'), blendWeight: 0.35 },
    // Elbow.
    { pos: rw[L('ForeArm')].clone(), radiusX: 0.041 * t, radiusZ: 0.042 * t, bone: L('ForeArm'), blendBone: L('Arm'), blendWeight: 0.4 },
    { pos: between(rig, L('ForeArm'), L('Hand'), 0.3), radiusX: 0.043 * t, radiusZ: 0.04 * t, bone: L('ForeArm') },
    // Wrist — flattened, which is what makes a forearm read as a forearm.
    { pos: between(rig, L('ForeArm'), L('Hand'), 0.92), radiusX: 0.031 * t, radiusZ: 0.024 * t, bone: L('ForeArm'), blendBone: L('Hand'), blendWeight: 0.4 },
    { pos: rw[L('Hand')].clone().add(V(0, -0.012, 0)), radiusX: 0.036 * t, radiusZ: 0.021 * t, bone: L('Hand'), squareness: 2.6 },
    // Stylised mitten hand: one soft volume, no individual fingers.
    { pos: rw[L('Hand')].clone().add(V(0, -0.072, 0.004)), radiusX: 0.038 * t, radiusZ: 0.022 * t, bone: L('Hand'), squareness: 2.8 },
    { pos: rw[L('Hand')].clone().add(V(0, -0.115, 0.006)), radiusX: 0.03 * t, radiusZ: 0.019 * t, bone: L('Hand'), squareness: 2.6 },
    { pos: rw[L('Hand')].clone().add(V(0, -0.138, 0.006)), radiusX: 0.014 * t, radiusZ: 0.012 * t, bone: L('Hand') },
  ];
}

function leg(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right'): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = s.limbs * s.mass;

  return [
    { pos: rw[L('UpLeg')].clone().add(V(0, 0.055, 0)), radiusX: 0.098 * t * s.hips, radiusZ: 0.098 * t, bone: L('UpLeg'), blendBone: 'Hips', blendWeight: 0.55 },
    { pos: rw[L('UpLeg')].clone().add(V(0, -0.01, 0)), radiusX: 0.09 * t, radiusZ: 0.093 * t, bone: L('UpLeg'), blendBone: 'Hips', blendWeight: 0.2 },
    // Thigh mass sits high; the taper toward the knee is what reads as a leg.
    { pos: between(rig, L('UpLeg'), L('Leg'), 0.35), radiusX: 0.083 * t, radiusZ: 0.086 * t, bone: L('UpLeg') },
    { pos: between(rig, L('UpLeg'), L('Leg'), 0.85), radiusX: 0.062 * t, radiusZ: 0.066 * t, bone: L('UpLeg'), blendBone: L('Leg'), blendWeight: 0.35 },
    { pos: rw[L('Leg')].clone(), radiusX: 0.058 * t, radiusZ: 0.062 * t, bone: L('Leg'), blendBone: L('UpLeg'), blendWeight: 0.4, squareness: 2.3 },
    // Calf.
    { pos: between(rig, L('Leg'), L('Foot'), 0.28), radiusX: 0.062 * t, radiusZ: 0.068 * t, bone: L('Leg') },
    { pos: between(rig, L('Leg'), L('Foot'), 0.66), radiusX: 0.047 * t, radiusZ: 0.05 * t, bone: L('Leg') },
    // Ankle.
    { pos: rw[L('Foot')].clone().add(V(0, 0.012, 0)), radiusX: 0.036 * t, radiusZ: 0.039 * t, bone: L('Foot'), blendBone: L('Leg'), blendWeight: 0.4 },
    { pos: rw[L('Foot')].clone().add(V(0, -0.03, 0.012)), radiusX: 0.04 * t, radiusZ: 0.05 * t, bone: L('Foot'), squareness: 2.6 },
    // Foot volume, swept forward toward the toe.
    { pos: rw[L('Foot')].clone().add(V(0, -0.052, 0.07)), radiusX: 0.042 * t, radiusZ: 0.06 * t, bone: L('Foot'), squareness: 3.0 },
    { pos: rw[L('ToeBase')].clone().add(V(0, 0.016, 0.03)), radiusX: 0.04 * t, radiusZ: 0.045 * t, bone: L('ToeBase'), blendBone: L('Foot'), blendWeight: 0.45, squareness: 3.0 },
    { pos: rw[L('ToeBase')].clone().add(V(0, 0.014, 0.058)), radiusX: 0.026 * t, radiusZ: 0.022 * t, bone: L('ToeBase'), squareness: 2.6 },
  ];
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

export function buildHead(rig: BuiltRig, face: FaceShape, headBoneIndex: number): THREE.BufferGeometry {
  const R = 0.128 * face.scale * rig.proportions.headScale * rig.proportions.height;
  const geo = new THREE.SphereGeometry(R, 40, 32);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();

    // Normalised vertical coordinate: -1 at the chin, +1 at the crown.
    const t = n.y;
    // Front-facing weight, so deformations only act on the face side.
    const front = Math.max(0, n.z);

    let sx = 0.9, sy = 1.0, sz = 0.94;

    // Cranium: slightly flattened at the back and top.
    sy *= THREE.MathUtils.lerp(1.0, 1.06 * face.cranium, Math.max(0, t));
    sz *= THREE.MathUtils.lerp(1.0, 0.93, Math.max(0, -n.z) * Math.max(0, t));

    // Jaw taper: below the ear line the head narrows toward the chin.
    const below = Math.max(0, -t);
    const jawTaper = THREE.MathUtils.lerp(1.0, 0.66 / face.jaw, Math.pow(below, 1.35));
    sx *= jawTaper;
    sz *= THREE.MathUtils.lerp(1.0, 0.88, Math.pow(below, 1.6));

    v.set(n.x * R * sx, n.y * R * sy, n.z * R * sz);

    // Chin projection.
    const chinMask = Math.pow(Math.max(0, -t), 1.8) * front;
    v.z += chinMask * R * 0.16 * face.chin;
    v.y -= chinMask * R * 0.06;

    // Brow ridge just above the eye line.
    const browMask = Math.exp(-Math.pow((t - 0.16) / 0.11, 2)) * front;
    v.z += browMask * R * 0.045 * face.brow;

    // Cheekbones.
    const cheekMask = Math.exp(-Math.pow((t + 0.02) / 0.16, 2)) * front * Math.abs(n.x);
    v.z += cheekMask * R * 0.05 * face.cheeks;
    v.x += Math.sign(n.x) * cheekMask * R * 0.055 * face.cheeks;

    // Eye sockets: a shallow recess so the eyeballs sit inside the head.
    const socketMask = Math.exp(-Math.pow((t - 0.06) / 0.075, 2))
      * Math.exp(-Math.pow((Math.abs(n.x) - 0.36) / 0.2, 2)) * front;
    v.z -= socketMask * R * 0.055;

    // Nose: a soft stylised wedge rather than a modelled feature.
    const noseMask = Math.exp(-Math.pow((t + 0.02) / 0.13, 2))
      * Math.exp(-Math.pow(n.x / 0.13, 2)) * Math.pow(front, 2);
    v.z += noseMask * R * 0.155;

    // Lip shelf.
    const lipMask = Math.exp(-Math.pow((t + 0.32) / 0.09, 2))
      * Math.exp(-Math.pow(n.x / 0.3, 2)) * front;
    v.z += lipMask * R * 0.035;

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
  geo.translate(0, rig.restWorld.Head.y + R * 0.42, 0.008);
  return geo;
}

export function buildBody(rig: BuiltRig, shape: BodyShape, segments = 20): THREE.BufferGeometry {
  const sub = 2;
  const parts = [
    loft(torso(rig, shape), { segments, capStart: true, capEnd: false, subdivisions: sub, uvOffset: [0, 0], uvScale: [0.5, 0.5] }),
    loft(neck(rig, shape), { segments: Math.round(segments * 0.7), capStart: false, capEnd: true, subdivisions: sub, uvOffset: [0.5, 0], uvScale: [0.25, 0.2] }),
    loft(arm(rig, shape, 'Left'), { segments: Math.round(segments * 0.8), capStart: true, capEnd: true, subdivisions: sub, uvOffset: [0, 0.5], uvScale: [0.25, 0.5] }),
    loft(arm(rig, shape, 'Right'), { segments: Math.round(segments * 0.8), capStart: true, capEnd: true, subdivisions: sub, uvOffset: [0.25, 0.5], uvScale: [0.25, 0.5] }),
    loft(leg(rig, shape, 'Left'), { segments: Math.round(segments * 0.9), capStart: true, capEnd: true, subdivisions: sub, uvOffset: [0.5, 0.5], uvScale: [0.25, 0.5] }),
    loft(leg(rig, shape, 'Right'), { segments: Math.round(segments * 0.9), capStart: true, capEnd: true, subdivisions: sub, uvOffset: [0.75, 0.5], uvScale: [0.25, 0.5] }),
  ];
  return assemble(parts);
}
