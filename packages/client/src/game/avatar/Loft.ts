import * as THREE from 'three';
import type { BoneName } from './Skeleton.js';
import { BONE_INDEX } from './Skeleton.js';

/**
 * A cross-section of a lofted limb or torso. Elliptical rather than circular
 * because almost nothing on a body is round: a forearm is wide and flat, a
 * chest is much wider than it is deep.
 */
export interface Station {
  /** Rest-pose world position of the ring centre. */
  pos: THREE.Vector3;
  radiusX: number;
  radiusZ: number;
  /** Bone that drives this ring. */
  bone: BoneName;
  /** Secondary bone for joint blending, with its weight in [0,1]. */
  blendBone?: BoneName;
  blendWeight?: number;
  /** Extra rounding of the ellipse corners; 2 = ellipse, 4 = squarish. */
  squareness?: number;
  /** Rotation of the cross-section about the path, in radians. */
  roll?: number;
  /** Per-station scale on the profile, for taper without changing radii. */
  scale?: number;
}

export interface LoftOptions {
  /** Vertices around each ring. */
  segments: number;
  capStart?: boolean;
  capEnd?: boolean;
  /**
   * Cap dome height as a fraction of the end ring's smaller radius. A flat disc
   * catches the key light as a hard plate — the very artefact that made the
   * first pass read as a shop mannequin — so caps are domed by default.
   * 0 falls back to the old flat disc, which is only ever right for a cap that
   * is fully buried inside another volume.
   */
  capRound?: number;
  /** Rings between the end ring and the dome's pole. */
  capRings?: number;
  /** Sample count between stations; >1 subdivides for a smoother silhouette. */
  subdivisions?: number;
  /** Offsets the whole loft's UV island so parts do not overlap in UV space. */
  uvOffset?: [number, number];
  uvScale?: [number, number];
}

interface Built {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  skinIndices: number[];
  skinWeights: number[];
}

/** Superellipse profile: |x/a|^n + |z/b|^n = 1. */
function profilePoint(angle: number, rx: number, rz: number, n: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (n === 2) return [c * rx, s * rz];
  const p = 2 / n;
  const x = Math.sign(c) * Math.pow(Math.abs(c), p) * rx;
  const z = Math.sign(s) * Math.pow(Math.abs(s), p) * rz;
  return [x, z];
}

/** Catmull-Rom interpolation of a station attribute across the path. */
export function lerpStation(a: Station, b: Station, t: number): Station {
  return {
    pos: new THREE.Vector3().lerpVectors(a.pos, b.pos, t),
    radiusX: THREE.MathUtils.lerp(a.radiusX, b.radiusX, t),
    radiusZ: THREE.MathUtils.lerp(a.radiusZ, b.radiusZ, t),
    bone: t < 0.5 ? a.bone : b.bone,
    blendBone: t < 0.5 ? (a.blendBone ?? b.bone) : (b.blendBone ?? a.bone),
    blendWeight: THREE.MathUtils.lerp(a.blendWeight ?? 0, b.blendWeight ?? 0, t),
    squareness: THREE.MathUtils.lerp(a.squareness ?? 2, b.squareness ?? 2, t),
    roll: THREE.MathUtils.lerp(a.roll ?? 0, b.roll ?? 0, t),
    scale: THREE.MathUtils.lerp(a.scale ?? 1, b.scale ?? 1, t),
  };
}

/**
 * Cuts a vertically-monotonic station path to the slab [fromY, toY], inserting
 * an interpolated ring exactly on each cut plane. Garments hem where the
 * designer asked rather than at whichever body station happened to fall
 * nearby — which is what used to leave a band of skin above the waistband.
 */
export function sliceStationsByY(stations: Station[], fromY: number, toY: number): Station[] {
  const lo = Math.min(fromY, toY);
  const hi = Math.max(fromY, toY);
  const out: Station[] = [];

  const crossing = (a: Station, b: Station, y: number) => {
    const dy = b.pos.y - a.pos.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (y - a.pos.y) / dy;
    return t > 1e-4 && t < 1 - 1e-4 ? lerpStation(a, b, t) : null;
  };

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    if (st.pos.y >= lo - 1e-6 && st.pos.y <= hi + 1e-6) out.push(st);
    const next = stations[i + 1];
    if (!next) continue;
    // A segment can cross both planes; emit them in path order.
    const cuts = [crossing(st, next, lo), crossing(st, next, hi)]
      .filter((c): c is Station => c !== null)
      .sort((a, b) => a.pos.distanceToSquared(st.pos) - b.pos.distanceToSquared(st.pos));
    for (const c of cuts) out.push(c);
  }

  // A slab thinner than the station spacing yields nothing; fall back to the
  // single nearest ring so a garment never silently disappears.
  if (out.length < 2) {
    const mid = (lo + hi) / 2;
    const nearest = stations.reduce((best, st) =>
      Math.abs(st.pos.y - mid) < Math.abs(best.pos.y - mid) ? st : best);
    return [nearest];
  }
  return out;
}

/**
 * Sweeps an elliptical profile along a station path using parallel-transport
 * frames, which keeps the cross-section from spinning as the path bends —
 * the classic artefact of a naive Frenet frame on a nearly straight limb.
 */
export function loft(stationsIn: Station[], opts: LoftOptions): Built {
  const sub = Math.max(1, opts.subdivisions ?? 1);
  const stations: Station[] = [];
  for (let i = 0; i < stationsIn.length - 1; i++) {
    for (let s = 0; s < sub; s++) {
      stations.push(lerpStation(stationsIn[i], stationsIn[i + 1], s / sub));
    }
  }
  stations.push(stationsIn[stationsIn.length - 1]);

  const N = opts.segments;
  const out: Built = { positions: [], normals: [], uvs: [], indices: [], skinIndices: [], skinWeights: [] };

  // Tangents, with endpoints extrapolated so the caps stay square to the path.
  const tangents = stations.map((st, i) => {
    const prev = stations[Math.max(0, i - 1)];
    const next = stations[Math.min(stations.length - 1, i + 1)];
    const t = new THREE.Vector3().subVectors(next.pos, prev.pos);
    return t.lengthSq() < 1e-9 ? new THREE.Vector3(0, -1, 0) : t.normalize();
  });

  // Parallel transport: seed a normal, then rotate it by the minimal rotation
  // that carries each tangent onto the next.
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  {
    const t0 = tangents[0];
    const seed = Math.abs(t0.y) > 0.92 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    let n = new THREE.Vector3().crossVectors(t0, seed).normalize();
    let b = new THREE.Vector3().crossVectors(t0, n).normalize();
    normals.push(n.clone());
    binormals.push(b.clone());
    for (let i = 1; i < stations.length; i++) {
      const q = new THREE.Quaternion().setFromUnitVectors(tangents[i - 1], tangents[i]);
      n = n.clone().applyQuaternion(q).normalize();
      b = new THREE.Vector3().crossVectors(tangents[i], n).normalize();
      n = new THREE.Vector3().crossVectors(b, tangents[i]).normalize();
      normals.push(n.clone());
      binormals.push(b.clone());
    }
  }

  const uvOff = opts.uvOffset ?? [0, 0];
  const uvScl = opts.uvScale ?? [1, 1];

  // Cumulative arc length gives a v coordinate that does not stretch on
  // sections where stations are packed closely together.
  const arc: number[] = [0];
  for (let i = 1; i < stations.length; i++) {
    arc.push(arc[i - 1] + stations[i].pos.distanceTo(stations[i - 1].pos));
  }
  const total = arc[arc.length - 1] || 1;

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const n = normals[i];
    const b = binormals[i];
    const sc = st.scale ?? 1;
    const roll = st.roll ?? 0;
    const sq = st.squareness ?? 2;

    for (let j = 0; j <= N; j++) {
      const a = (j / N) * Math.PI * 2 + roll;
      const [px, pz] = profilePoint(a, st.radiusX * sc, st.radiusZ * sc, sq);
      const v = new THREE.Vector3()
        .copy(st.pos)
        .addScaledVector(n, px)
        .addScaledVector(b, pz);
      out.positions.push(v.x, v.y, v.z);

      // Placeholder; recomputed from the faces once the parts are assembled.
      out.normals.push(0, 1, 0);

      out.uvs.push(
        uvOff[0] + (j / N) * uvScl[0],
        uvOff[1] + (arc[i] / total) * uvScl[1],
      );

      const bw = st.blendWeight ?? 0;
      const primary = BONE_INDEX[st.bone];
      const secondary = BONE_INDEX[st.blendBone ?? st.bone];
      out.skinIndices.push(primary, secondary, 0, 0);
      out.skinWeights.push(1 - bw, bw, 0, 0);
    }
  }

  const ring = N + 1;
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * ring + j;
      const bIdx = a + ring;
      // With a right-handed (normal, binormal, tangent) frame, walking the
      // ring counter-clockwise and stepping along the path must wind
      // a -> a+1 -> b for the face to point outward.
      out.indices.push(a, a + 1, bIdx, a + 1, bIdx + 1, bIdx);
    }
  }

  const pushVertex = (p: THREE.Vector3, st: Station, u: number, vRow: number) => {
    out.positions.push(p.x, p.y, p.z);
    out.normals.push(0, 1, 0);
    out.uvs.push(uvOff[0] + u * uvScl[0], uvOff[1] + vRow * uvScl[1]);
    const bw = st.blendWeight ?? 0;
    out.skinIndices.push(BONE_INDEX[st.bone], BONE_INDEX[st.blendBone ?? st.bone], 0, 0);
    out.skinWeights.push(1 - bw, bw, 0, 0);
  };

  const addCap = (stIdx: number, flip: boolean) => {
    const st = stations[stIdx];
    const dir = flip ? tangents[stIdx].clone().negate() : tangents[stIdx].clone();
    const n = normals[stIdx];
    const b = binormals[stIdx];
    const sc = st.scale ?? 1;
    const rx = st.radiusX * sc;
    const rz = st.radiusZ * sc;
    const sq = st.squareness ?? 2;
    const roll = st.roll ?? 0;
    const vRow = flip ? 0 : 1;
    const round = opts.capRound ?? 0.85;
    const height = Math.min(rx, rz) * round;
    const rings = height > 1e-5 ? Math.max(1, opts.capRings ?? 2) : 0;
    const base = stIdx * ring;
    const first = out.positions.length / 3;

    for (let k = 1; k <= rings; k++) {
      // Quarter-ellipse profile, so the dome meets the tube tangentially
      // instead of creasing at the seam.
      const ang = (k / (rings + 1)) * Math.PI * 0.5;
      const shrink = Math.cos(ang);
      const centre = st.pos.clone().addScaledVector(dir, height * Math.sin(ang));
      for (let j = 0; j <= N; j++) {
        const a = (j / N) * Math.PI * 2 + roll;
        const [px, pz] = profilePoint(a, rx * shrink, rz * shrink, sq);
        const p = centre.clone().addScaledVector(n, px).addScaledVector(b, pz);
        pushVertex(p, st, j / N, vRow);
      }
    }

    const pole = out.positions.length / 3;
    pushVertex(st.pos.clone().addScaledVector(dir, height), st, 0.5, vRow);

    let prev = base;
    for (let k = 0; k < rings; k++) {
      const cur = first + k * ring;
      for (let j = 0; j < N; j++) {
        const a = prev + j;
        const c = cur + j;
        // The dome grows along -tangent on a start cap, which reverses the
        // path order and therefore the winding.
        if (flip) out.indices.push(a, c, a + 1, a + 1, c, c + 1);
        else out.indices.push(a, a + 1, c, a + 1, c + 1, c);
      }
      prev = cur;
    }
    for (let j = 0; j < N; j++) {
      if (flip) out.indices.push(prev + j, pole, prev + j + 1);
      else out.indices.push(prev + j, prev + j + 1, pole);
    }
  };

  if (opts.capStart) addCap(0, true);
  if (opts.capEnd) addCap(stations.length - 1, false);

  return out;
}

/** Merges several lofts into one BufferGeometry with skinning attributes. */
export function assemble(parts: Built[]): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  let offset = 0;

  for (const p of parts) {
    positions.push(...p.positions);
    normals.push(...p.normals);
    uvs.push(...p.uvs);
    skinIndices.push(...p.skinIndices);
    skinWeights.push(...p.skinWeights);
    for (const i of p.indices) indices.push(i + offset);
    offset += p.positions.length / 3;
  }

  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('uv1', new THREE.Float32BufferAttribute(uvs, 2)); // aoMap
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
