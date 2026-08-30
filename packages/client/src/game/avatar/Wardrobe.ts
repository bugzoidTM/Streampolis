import * as THREE from 'three';
import { loft, assemble, type Station } from './Loft.js';
import type { BoneName, BuiltRig } from './Skeleton.js';
import { BONE_INDEX } from './Skeleton.js';
import type { BodyShape } from './BodyBuilder.js';
import { makeClothMaterial, makeHairMaterial } from './Materials.js';

/**
 * Garments are lofted over the same rest pose as the body with an inflation
 * offset, so they share the skeleton exactly (SPECs §13) and never require a
 * per-combination mesh. Anything the garment fully covers can be skipped by
 * the body shader, but at this polygon count it is cheaper to just let it be
 * hidden than to build per-garment body masks.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface GarmentSpec {
  stations: Station[];
  segments: number;
  capStart?: boolean;
  capEnd?: boolean;
}

function inflate(s: Station, dx: number, dz = dx): Station {
  return { ...s, pos: s.pos.clone(), radiusX: s.radiusX + dx, radiusZ: s.radiusZ + dz };
}

// --------------------------------------------------------------------------
// Tops
// --------------------------------------------------------------------------

function torsoBand(rig: BuiltRig, s: BodyShape, fromY: number, toY: number, thickness: number): Station[] {
  const m = s.mass;
  const rw = rig.restWorld;
  const all: Station[] = [
    { pos: V(0, rw.Hips.y - 0.06, 0.002), radiusX: 0.148 * m * s.hips, radiusZ: 0.106 * m, bone: 'Hips', squareness: 2.5 },
    { pos: V(0, rw.Hips.y + 0.035, 0),    radiusX: 0.14 * m * s.hips,  radiusZ: 0.101 * m, bone: 'Hips', blendBone: 'Spine', blendWeight: 0.35, squareness: 2.4 },
    { pos: V(0, rw.Spine.y + 0.03, -0.004), radiusX: 0.127 * m * s.waist, radiusZ: 0.097 * m * s.waist, bone: 'Spine', blendBone: 'Spine1', blendWeight: 0.4, squareness: 2.3 },
    { pos: V(0, rw.Spine1.y + 0.03, -0.002), radiusX: 0.151 * m, radiusZ: 0.11 * m, bone: 'Spine1', blendBone: 'Spine2', blendWeight: 0.35, squareness: 2.3 },
    { pos: V(0, rw.Spine2.y - 0.02, 0.004), radiusX: 0.172 * m * s.chest, radiusZ: 0.121 * m * s.chest, bone: 'Spine2', squareness: 2.5 },
    { pos: V(0, rw.Spine2.y + 0.052, 0.002), radiusX: 0.184 * m * s.shoulders, radiusZ: 0.115 * m, bone: 'Spine2', squareness: 2.7 },
    { pos: V(0, rw.Spine2.y + 0.098, -0.004), radiusX: 0.168 * m * s.shoulders, radiusZ: 0.097 * m, bone: 'Spine2', squareness: 3.0 },
    { pos: V(0, rw.Neck.y - 0.018, -0.004), radiusX: 0.104 * m, radiusZ: 0.082 * m, bone: 'Spine2', blendBone: 'Neck', blendWeight: 0.4, squareness: 2.4 },
  ];
  return all.filter((st) => st.pos.y >= fromY - 1e-4 && st.pos.y <= toY + 1e-4).map((st) => inflate(st, thickness));
}

function sleeve(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right', length: number, thickness: number): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = s.limbs * s.mass;
  const sign = side === 'Left' ? 1 : -1;
  const shoulder = rw[L('Arm')];
  const elbow = rw[L('ForeArm')];
  const wrist = rw[L('Hand')];

  const at = (u: number) => {
    // u in 0..2: 0 = shoulder, 1 = elbow, 2 = wrist.
    if (u <= 1) return new THREE.Vector3().lerpVectors(shoulder, elbow, u);
    return new THREE.Vector3().lerpVectors(elbow, wrist, u - 1);
  };
  const boneAt = (u: number): BoneName => (u < 0.95 ? L('Arm') : u < 1.9 ? L('ForeArm') : L('Hand'));
  const radiusAt = (u: number) => THREE.MathUtils.lerp(0.058, 0.031, Math.min(1, u / 2)) * t;

  const out: Station[] = [
    { pos: shoulder.clone().add(V(-sign * 0.03, 0.036, 0)), radiusX: 0.078 * t + thickness, radiusZ: 0.076 * t + thickness, bone: L('Arm'), blendBone: 'Spine2', blendWeight: 0.55 },
  ];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const u = (i / steps) * length;
    out.push({
      pos: at(u),
      radiusX: radiusAt(u) + thickness,
      radiusZ: radiusAt(u) + thickness,
      bone: boneAt(u),
      blendBone: boneAt(Math.max(0, u - 0.18)),
      blendWeight: 0.32,
    });
  }
  // A cuff flare stops the sleeve ending in a hard cylinder edge.
  const last = out[out.length - 1];
  out.push({ ...last, pos: last.pos.clone().add(V(0, -0.014, 0)), radiusX: last.radiusX * 1.06, radiusZ: last.radiusZ * 1.06 });
  return out;
}

function legWrap(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right', fromU: number, toU: number, thickness: number, flare = 1): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = s.limbs * s.mass;
  const hip = rw[L('UpLeg')];
  const knee = rw[L('Leg')];
  const ankle = rw[L('Foot')];

  const at = (u: number) => (u <= 1
    ? new THREE.Vector3().lerpVectors(hip, knee, u)
    : new THREE.Vector3().lerpVectors(knee, ankle, u - 1));
  const boneAt = (u: number): BoneName => (u < 0.95 ? L('UpLeg') : u < 1.95 ? L('Leg') : L('Foot'));
  const radiusAt = (u: number) => {
    if (u < 0.35) return THREE.MathUtils.lerp(0.098, 0.084, u / 0.35) * t;
    if (u < 1) return THREE.MathUtils.lerp(0.084, 0.06, (u - 0.35) / 0.65) * t;
    if (u < 1.3) return THREE.MathUtils.lerp(0.06, 0.065, (u - 1) / 0.3) * t;
    return THREE.MathUtils.lerp(0.065, 0.042, (u - 1.3) / 0.7) * t;
  };

  const out: Station[] = [];
  const steps = 9;
  for (let i = 0; i <= steps; i++) {
    const u = THREE.MathUtils.lerp(fromU, toU, i / steps);
    // Flare grows toward the hem, which is what separates trousers from tights.
    const f = THREE.MathUtils.lerp(1, flare, i / steps);
    out.push({
      pos: at(u),
      radiusX: radiusAt(u) * f + thickness,
      radiusZ: radiusAt(u) * f + thickness,
      bone: boneAt(u),
      blendBone: boneAt(Math.max(0, u - 0.2)),
      blendWeight: 0.35,
      squareness: 2.2,
    });
  }
  return out;
}

function shoe(rig: BuiltRig, s: BodyShape, side: 'Left' | 'Right', chunky: number): Station[] {
  const L = (n: string) => `${side}${n}` as BoneName;
  const rw = rig.restWorld;
  const t = s.limbs * s.mass;
  const foot = rw[L('Foot')];
  const toe = rw[L('ToeBase')];
  const k = 0.008 * chunky;
  return [
    { pos: foot.clone().add(V(0, 0.03, -0.012)), radiusX: 0.043 * t + k, radiusZ: 0.048 * t + k, bone: L('Foot'), blendBone: L('Leg'), blendWeight: 0.3, squareness: 2.6 },
    { pos: foot.clone().add(V(0, -0.022, 0.004)), radiusX: 0.047 * t + k, radiusZ: 0.058 * t + k, bone: L('Foot'), squareness: 2.8 },
    { pos: foot.clone().add(V(0, -0.05, 0.062)), radiusX: 0.05 * t + k, radiusZ: 0.066 * t + k, bone: L('Foot'), squareness: 3.2 },
    { pos: toe.clone().add(V(0, 0.014, 0.026)), radiusX: 0.048 * t + k, radiusZ: 0.05 * t + k, bone: L('ToeBase'), blendBone: L('Foot'), blendWeight: 0.45, squareness: 3.2 },
    { pos: toe.clone().add(V(0, 0.016, 0.062)), radiusX: 0.038 * t + k, radiusZ: 0.032 * t + k, bone: L('ToeBase'), squareness: 2.8 },
    { pos: toe.clone().add(V(0, 0.018, 0.078)), radiusX: 0.018 * t, radiusZ: 0.016 * t, bone: L('ToeBase') },
  ];
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
    segments: s.segments, capStart: s.capStart, capEnd: s.capEnd, subdivisions: 2,
  }))),
  material,
});

export const TOP_BUILDERS: Record<string, Builder> = {
  top_tee_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, rig.restWorld.Hips.y - 0.06, 999, 0.011), segments: 22, capStart: true, capEnd: true },
    { stations: sleeve(rig, s, 'Left', 0.55, 0.012), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 0.55, 0.012), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.86, sheen: 0.28 })),

  top_hoodie_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, rig.restWorld.Hips.y - 0.06, 999, 0.026), segments: 22, capStart: true, capEnd: true },
    { stations: sleeve(rig, s, 'Left', 1.9, 0.024), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 1.9, 0.024), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.92, sheen: 0.18 })),

  top_jacket_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, rig.restWorld.Hips.y - 0.02, 999, 0.032), segments: 22, capStart: true, capEnd: true },
    { stations: sleeve(rig, s, 'Left', 2.0, 0.03), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 2.0, 0.03), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.44, sheen: 0.5, metalness: 0.05 })),

  top_blazer_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, rig.restWorld.Hips.y - 0.08, 999, 0.022), segments: 22, capStart: true, capEnd: true },
    { stations: sleeve(rig, s, 'Left', 1.95, 0.02), segments: 16, capEnd: true },
    { stations: sleeve(rig, s, 'Right', 1.95, 0.02), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.68, sheen: 0.42 })),

  top_holo_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, rig.restWorld.Spine.y, 999, 0.009), segments: 22, capStart: true, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.18, metalness: 0.55, sheen: 0.9, emissive: color, emissiveIntensity: 0.35 })),
};

export const BOTTOM_BUILDERS: Record<string, Builder> = {
  bottom_jeans_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, -999, rig.restWorld.Spine.y + 0.02, 0.014), segments: 22, capStart: true },
    { stations: legWrap(rig, s, 'Left', 0.05, 1.95, 0.014, 1.06), segments: 16, capEnd: true },
    { stations: legWrap(rig, s, 'Right', 0.05, 1.95, 0.014, 1.06), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.88, sheen: 0.22 })),

  bottom_cargo_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, -999, rig.restWorld.Spine.y + 0.02, 0.02), segments: 22, capStart: true },
    { stations: legWrap(rig, s, 'Left', 0.05, 1.95, 0.026, 1.18), segments: 16, capEnd: true },
    { stations: legWrap(rig, s, 'Right', 0.05, 1.95, 0.026, 1.18), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.9, sheen: 0.16 })),

  bottom_track_01: (rig, s, color) => build([
    { stations: torsoBand(rig, s, -999, rig.restWorld.Spine.y + 0.02, 0.018), segments: 22, capStart: true },
    { stations: legWrap(rig, s, 'Left', 0.05, 2.0, 0.022, 0.92), segments: 16, capEnd: true },
    { stations: legWrap(rig, s, 'Right', 0.05, 2.0, 0.022, 0.92), segments: 16, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.6, sheen: 0.5 })),

  bottom_skirt_01: (rig, s, color) => {
    const rw = rig.restWorld;
    const m = s.mass;
    const st: Station[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      st.push({
        pos: V(0, THREE.MathUtils.lerp(rw.Spine.y + 0.02, rw.Hips.y - 0.32, t), 0),
        // The A-line flare is the whole silhouette of the garment.
        radiusX: (0.15 + t * 0.13) * m,
        radiusZ: (0.115 + t * 0.11) * m,
        bone: t < 0.35 ? 'Spine' : 'Hips',
        blendBone: 'Hips',
        blendWeight: t < 0.35 ? 0.5 : 0,
        // Pleats.
        squareness: 2.1,
        scale: 1 + Math.sin(t * 3) * 0.01,
      });
    }
    return build([{ stations: st, segments: 30, capStart: true, capEnd: true }],
      makeClothMaterial({ color, roughness: 0.8, sheen: 0.36 }));
  },
};

export const SHOE_BUILDERS: Record<string, Builder> = {
  shoes_sneaker_01: (rig, s, color) => build([
    { stations: shoe(rig, s, 'Left', 1.0), segments: 16, capStart: true, capEnd: true },
    { stations: shoe(rig, s, 'Right', 1.0), segments: 16, capStart: true, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.66, sheen: 0.3 })),

  shoes_boot_01: (rig, s, color) => build([
    { stations: shoe(rig, s, 'Left', 1.8), segments: 16, capStart: true, capEnd: true },
    { stations: shoe(rig, s, 'Right', 1.8), segments: 16, capStart: true, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.4, sheen: 0.55 })),

  shoes_glow_01: (rig, s, color) => build([
    { stations: shoe(rig, s, 'Left', 1.3), segments: 16, capStart: true, capEnd: true },
    { stations: shoe(rig, s, 'Right', 1.3), segments: 16, capStart: true, capEnd: true },
  ], makeClothMaterial({ color, roughness: 0.3, sheen: 0.7, emissive: color, emissiveIntensity: 1.6 })),
};

/** Default colourways so the catalogue reads as designed rather than random. */
export const ITEM_COLORS: Record<string, string> = {
  top_tee_01: '#e8e4dd', top_hoodie_01: '#3d4550', top_jacket_01: '#2c3038',
  top_blazer_01: '#242a35', top_holo_01: '#7cd7ff',
  bottom_jeans_01: '#3f5570', bottom_cargo_01: '#6a6350', bottom_track_01: '#22242a',
  bottom_skirt_01: '#8a3f54',
  shoes_sneaker_01: '#f0eeea', shoes_boot_01: '#241f1c', shoes_glow_01: '#39d98a',
};
