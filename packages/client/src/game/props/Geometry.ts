import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Geometry plumbing shared by every procedural prop.
 *
 * The whole world is authored as small primitives that get baked together with
 * `merge()` into one buffer per material, so a bench made of eight boxes still
 * costs a single instanced draw call (SPECs §7).
 */

const KEEP = ['position', 'normal', 'uv'] as const;

/** Drops attributes that would make two otherwise identical parts unmergeable. */
function normalize(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const out = new THREE.BufferGeometry();
  for (const name of KEEP) {
    const attr = flat.getAttribute(name);
    if (attr) out.setAttribute(name, attr);
  }
  if (!out.getAttribute('uv')) {
    const count = out.getAttribute('position').count;
    out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  }
  if (flat !== geo) geo.dispose();
  return out;
}

/** Moves/rotates a geometry in place and returns it, for use inside merge lists. */
export function place(
  geo: THREE.BufferGeometry,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  if (rx || ry || rz) {
    const e = new THREE.Euler(rx, ry, rz);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(e));
  }
  if (x || y || z) geo.translate(x, y, z);
  return geo;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = parts.map(normalize);
  const out = mergeGeometries(normalized);
  for (const g of normalized) g.dispose();
  if (!out) throw new Error('merge failed: incompatible geometry parts');
  out.computeBoundingSphere();
  return out;
}

/**
 * Box-projects UVs from object space so that one texture tile always covers
 * `metersPerTile` metres, whatever the mesh size. Without this, a 30 m wall and
 * a 0.4 m post sharing a material would show wildly different texel densities.
 */
export function boxUV(geo: THREE.BufferGeometry, metersPerTile = 1, offset = 0): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  const s = 1 / metersPerTile;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = x; v = z; }        // floors and ceilings
    else if (nx >= nz) { u = z; v = y; }               // walls facing ±X
    else { u = x; v = y; }                             // walls facing ±Z
    uv[i * 2] = u * s + offset;
    uv[i * 2 + 1] = v * s + offset;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Multiplies existing UVs — for meshes whose unwrap is already meaningful. */
export function scaleUV(geo: THREE.BufferGeometry, su: number, sv = su): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

export function rbox(w: number, h: number, d: number, r = 0.02, seg = 2): THREE.BufferGeometry {
  // RoundedBoxGeometry throws if the radius exceeds half the smallest side.
  const safe = Math.min(r, Math.min(w, h, d) * 0.49);
  return new RoundedBoxGeometry(w, h, d, seg, safe);
}

export const cyl = (rt: number, rb: number, h: number, seg = 14, open = false) =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);

export const sph = (r: number, w = 12, h = 8) => new THREE.SphereGeometry(r, w, h);

/**
 * Extrudes a closed 2D outline into a slab lying in the XZ plane, which is how
 * kerbs, planter rims and stage aprons are authored.
 */
export function slab(points: THREE.Vector2[], height: number, bevel = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(points);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: bevel > 0,
    bevelSize: bevel, bevelThickness: bevel, bevelSegments: 1,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Closed ring (annulus) lying flat, used for plaza bands and planter walls. */
export function ringSlab(inner: number, outer: number, height: number, seg = 48): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height, bevelEnabled: false, curveSegments: seg / 4,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * A ground plate with low-amplitude vertex noise. Perfectly flat ground reads
 * as a debug placeholder under grazing light; a couple of centimetres of
 * undulation is enough to make the sun rake across it.
 */
export function undulatingPlane(
  size: number, segments: number, amplitude: number,
  noise: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, noise(pos.getX(i), pos.getZ(i)) * amplitude);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Instanced draw of one baked prop part. Returns the mesh, already populated. */
export function instance(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  matrices: THREE.Matrix4[],
  { cast = true, receive = true }: { cast?: boolean; receive?: boolean } = {},
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.frustumCulled = true;
  return mesh;
}

export function xform(
  x: number, y: number, z: number,
  ry = 0, s = 1, rx = 0, rz = 0,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')),
    new THREE.Vector3(s, s, s),
  );
}
