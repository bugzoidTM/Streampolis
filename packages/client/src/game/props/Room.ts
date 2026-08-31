import * as THREE from 'three';
import type { RoomShell, WallOpening, WallSide } from '@streampolis/shared';
import type { MatLib } from './Materials.js';
import { box, boxUV, merge, place, type Prop } from './Geometry.js';
import { doorFrame, windowFrame } from './Interior.js';

/**
 * Builds the box a room lives in: floor, four walls pierced by their openings,
 * skirting, cornice, ceiling, and the frames and daylight that make a hole in
 * a wall read as a window instead of a hole in a wall.
 *
 * The shell is authored from the SAME `RoomShell` the collision table is built
 * from (packages/shared/src/interiors.ts), so a door you can see is a door you
 * can walk through and a wall you can see is a wall you cannot.
 */

export interface ShellStyle {
  floor: THREE.Material;
  wall: THREE.Material;
  ceiling: THREE.Material;
  trim: THREE.Material;
  /** Metres per texture tile on the floor. */
  floorTile?: number;
  wallTile?: number;
  /** Sky colours seen through a glazed opening. */
  view?: { top: number; bottom: number; sun: number };
  /** Skirting and cornice add scale cues; off for arenas. */
  mouldings?: boolean;
}

/** Which way a wall faces, and how a world coordinate maps into its local X. */
const WALLS: Record<WallSide, { ry: number; flip: 1 | -1; axis: 'x' | 'z' }> = {
  north: { ry: 0, flip: 1, axis: 'x' },
  south: { ry: Math.PI, flip: -1, axis: 'x' },
  west: { ry: Math.PI / 2, flip: -1, axis: 'z' },
  east: { ry: -Math.PI / 2, flip: 1, axis: 'z' },
};

const VIEW_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * What you see through the window. A real exterior behind every pane would
 * mean loading the city from inside a flat, which SPECs §10 exists to prevent:
 * a gradient with a haze band and a skyline of blocks costs one draw call and
 * survives being looked at from across the room.
 */
const VIEW_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uSun;

float block(float x, float seed) {
  float i = floor(x * 9.0 + seed);
  return 0.16 + fract(sin(i * 91.7 + seed) * 4371.3) * 0.30;
}

void main() {
  vec3 sky = mix(uBottom, uTop, pow(clamp(vUv.y, 0.0, 1.0), 0.8));
  // Haze thickens toward the horizon, which is what sells distance.
  sky = mix(sky, uSun, smoothstep(0.55, 0.0, vUv.y) * 0.55);

  float far = block(vUv.x, 3.0);
  float near = block(vUv.x * 0.62 + 0.2, 17.0) * 0.8;
  vec3 col = sky;
  col = mix(col, mix(sky, vec3(0.34, 0.36, 0.42), 0.55), step(vUv.y, far));
  col = mix(col, mix(sky, vec3(0.20, 0.21, 0.26), 0.75), step(vUv.y, near));
  gl_FragColor = vec4(col, 1.0);
}
`;

export function windowViewMaterial(top: number, bottom: number, sun: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(top).convertSRGBToLinear() },
      uBottom: { value: new THREE.Color(bottom).convertSRGBToLinear() },
      uSun: { value: new THREE.Color(sun).convertSRGBToLinear() },
    },
    vertexShader: VIEW_VERT,
    fragmentShader: VIEW_FRAG,
    fog: false,
  });
}

/**
 * Splits a wall run into the segments that survive its openings — the same
 * walk `shellColliders` does in the shared package, for the pieces of trim
 * that must stop at a doorway.
 */
function segments(span: number, gaps: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  let cursor = -span / 2;
  for (const [a, b] of sorted) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < span / 2) out.push([cursor, span / 2]);
  return out;
}

export interface BuiltShell {
  group: THREE.Group;
  /** Materials the shell created itself; the scene must dispose them. */
  disposables: Array<{ dispose(): void }>;
}

export function buildRoomShell(lib: MatLib, shell: RoomShell, style: ShellStyle): BuiltShell {
  const group = new THREE.Group();
  const disposables: Array<{ dispose(): void }> = [];
  const { width, depth, height, wall } = shell;
  const hw = width / 2;
  const hd = depth / 2;

  // --- floor and ceiling ---------------------------------------------------
  const floorGeo = new THREE.PlaneGeometry(width + wall * 2, depth + wall * 2);
  floorGeo.rotateX(-Math.PI / 2);
  boxUV(floorGeo, style.floorTile ?? 1.2);
  const floor = new THREE.Mesh(floorGeo, style.floor);
  floor.receiveShadow = true;
  group.add(floor);

  if (shell.ceiling) {
    const ceilGeo = new THREE.PlaneGeometry(width + wall * 2, depth + wall * 2);
    ceilGeo.rotateX(Math.PI / 2);
    boxUV(ceilGeo, 2.0);
    const ceil = new THREE.Mesh(ceilGeo, style.ceiling);
    ceil.position.y = height;
    ceil.receiveShadow = true;
    group.add(ceil);
  }

  // --- walls ---------------------------------------------------------------
  for (const side of Object.keys(WALLS) as WallSide[]) {
    const { ry, flip, axis } = WALLS[side];
    const span = axis === 'x' ? width : depth;
    const holes = shell.openings.filter((o) => o.side === side);

    const localOpenings = holes.map((o) => ({ x: o.x * flip, y: o.y, w: o.w, h: o.h }));
    const panel = wallGeometry(span, height, wall, localOpenings, style.wallTile ?? 1.4);
    const mesh = new THREE.Mesh(panel, style.wall);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    positionWall(mesh, side, hw, hd, wall);
    mesh.rotation.y = ry;
    group.add(mesh);

    // Frames sit in the hole, in world coordinates.
    for (const o of holes) {
      const prop = o.glazed
        ? windowFrame(lib, o.w, o.h, wall + 0.06)
        : doorFrame(lib, o.w, o.h, wall + 0.08);
      const frame = propGroup(prop);
      placeInOpening(frame, side, o, hw, hd, ry, o.glazed ? o.y + o.h / 2 : 0);
      group.add(frame);

      if (o.glazed && style.view) {
        const viewMat = windowViewMaterial(style.view.top, style.view.bottom, style.view.sun);
        disposables.push(viewMat);
        const plate = new THREE.PlaneGeometry(o.w * 1.9, o.h * 1.9);
        const view = new THREE.Mesh(plate, viewMat);
        // Pushed well outside the wall so the parallax through the frame is
        // visible when the player walks past.
        placeInOpening(view, side, o, hw + 0.9, hd + 0.9, ry, o.y + o.h / 2);
        group.add(view);

        // The pane is its own material, not a MatLib entry: making the shared
        // glass transparent would turn every window in the catalogue to fog.
        const paneMat = new THREE.MeshPhysicalMaterial({
          color: 0x9fc4e8, roughness: 0.04, metalness: 0,
          transparent: true, opacity: 0.14, envMapIntensity: 1.6,
        });
        disposables.push(paneMat);
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(o.w - 0.05, o.h - 0.05), paneMat);
        placeInOpening(pane, side, o, hw, hd, ry, o.y + o.h / 2);
        group.add(pane);
      }
    }

    if (style.mouldings !== false) {
      const doorGaps = holes
        .filter((o) => o.y < 0.4)
        .map((o) => [o.x * flip - o.w / 2 - 0.08, o.x * flip + o.w / 2 + 0.08] as [number, number]);
      const parts: THREE.BufferGeometry[] = [];
      for (const [a, b] of segments(span, doorGaps)) {
        parts.push(place(box(b - a, 0.11, 0.035), (a + b) / 2, 0.055, wall / 2 + 0.018));
      }
      parts.push(place(box(span, 0.06, 0.05), 0, height - 0.03, wall / 2 + 0.025));
      const trim = merge(parts);
      boxUV(trim, 0.6);
      const trimMesh = new THREE.Mesh(trim, style.trim);
      trimMesh.receiveShadow = true;
      positionWall(trimMesh, side, hw, hd, wall);
      trimMesh.rotation.y = ry;
      group.add(trimMesh);
    }
  }

  return { group, disposables };
}

/** Wall slab pierced by its openings, centred on X, sitting on y = 0. */
function wallGeometry(
  span: number, height: number, thickness: number,
  openings: Array<{ x: number; y: number; w: number; h: number }>,
  tile: number,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const sorted = [...openings].sort((a, b) => a.x - b.x);
  let cursor = -span / 2;
  for (const o of sorted) {
    const left = o.x - o.w / 2;
    if (left > cursor + 1e-4) {
      const w = left - cursor;
      parts.push(place(box(w, height, thickness), cursor + w / 2, height / 2, 0));
    }
    if (o.y > 1e-4) parts.push(place(box(o.w, o.y, thickness), o.x, o.y / 2, 0));
    const top = height - (o.y + o.h);
    if (top > 1e-4) parts.push(place(box(o.w, top, thickness), o.x, o.y + o.h + top / 2, 0));
    cursor = o.x + o.w / 2;
  }
  if (cursor < span / 2 - 1e-4) {
    const w = span / 2 - cursor;
    parts.push(place(box(w, height, thickness), cursor + w / 2, height / 2, 0));
  }
  const geo = merge(parts);
  boxUV(geo, tile);
  return geo;
}

function positionWall(obj: THREE.Object3D, side: WallSide, hw: number, hd: number, wall: number) {
  switch (side) {
    case 'north': obj.position.set(0, 0, -hd - wall / 2); break;
    case 'south': obj.position.set(0, 0, hd + wall / 2); break;
    case 'west': obj.position.set(-hw - wall / 2, 0, 0); break;
    case 'east': obj.position.set(hw + wall / 2, 0, 0); break;
  }
}

function placeInOpening(
  obj: THREE.Object3D, side: WallSide, o: WallOpening,
  hw: number, hd: number, ry: number, y: number,
) {
  switch (side) {
    case 'north': obj.position.set(o.x, y, -hd); break;
    case 'south': obj.position.set(o.x, y, hd); break;
    case 'west': obj.position.set(-hw, y, o.x); break;
    case 'east': obj.position.set(hw, y, o.x); break;
  }
  obj.rotation.y = ry;
}

function propGroup(prop: Prop): THREE.Group {
  const g = new THREE.Group();
  for (const p of prop) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.castShadow = p.cast ?? true;
    m.receiveShadow = p.receive ?? true;
    g.add(m);
  }
  return g;
}
