import * as THREE from 'three';
import type { MatLib } from './Materials.js';
import { box, boxUV, cyl, merge, place, rbox, ringSlab, type Prop } from './Geometry.js';

/**
 * Stage, arena and retail hardware.
 *
 * Everything a room needs to read as a *broadcast* space rather than a room
 * with a television in it: truss, lamps that are obviously theatrical, speaker
 * stacks, crowd barriers and the floor marks that tell a player where the shot
 * is. Authored facing +Z like every other prop, so the layout data can place
 * them with a single yaw.
 */

/** Box truss along X: two chords, two rails and a zig-zag web. */
export function truss(lib: MatLib, span: number, size = 0.34): Prop {
  const parts: THREE.BufferGeometry[] = [];
  const h = size, d = size;
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(place(cyl(0.035, 0.035, span, 8).rotateZ(Math.PI / 2), 0, (sy * h) / 2, (sz * d) / 2));
  }
  const bays = Math.max(4, Math.round(span / 0.75));
  for (let i = 0; i < bays; i++) {
    const x = -span / 2 + (span / bays) * (i + 0.5);
    const diag = cyl(0.018, 0.018, Math.hypot(h, span / bays), 6);
    diag.rotateX(i % 2 === 0 ? 0.62 : -0.62);
    for (const sz of [-1, 1]) {
      const c = diag.clone();
      c.rotateZ(i % 2 === 0 ? 0.5 : -0.5);
      parts.push(place(c, x, 0, (sz * d) / 2));
    }
    diag.dispose();
    parts.push(place(cyl(0.018, 0.018, h, 6), x, 0, -d / 2));
    parts.push(place(cyl(0.018, 0.018, h, 6), x, 0, d / 2));
  }
  const geo = merge(parts);
  boxUV(geo, 0.5);
  return [{ geo, mat: lib.metal('#3c4149', 0.42, 0.85), receive: false }];
}

/** Vertical truss tower with a base plate. */
export function trussTower(lib: MatLib, height = 8): Prop {
  const parts: THREE.BufferGeometry[] = [];
  const s = 0.42;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(place(cyl(0.045, 0.045, height, 8), (sx * s) / 2, height / 2, (sz * s) / 2));
  }
  const rungs = Math.round(height / 0.6);
  for (let i = 1; i < rungs; i++) {
    const y = (height / rungs) * i;
    for (const sz of [-1, 1]) {
      parts.push(place(cyl(0.02, 0.02, s, 6).rotateZ(Math.PI / 2), 0, y, (sz * s) / 2));
    }
    for (const sx of [-1, 1]) {
      parts.push(place(cyl(0.02, 0.02, s, 6).rotateX(Math.PI / 2), (sx * s) / 2, y, 0));
    }
  }
  parts.push(place(box(1.1, 0.09, 1.1), 0, 0.045, 0));
  const geo = merge(parts);
  boxUV(geo, 0.5);
  return [{ geo, mat: lib.metal('#33383f', 0.45, 0.85) }];
}

/**
 * A theatrical spot: yoke, barrel and a visible lens. The actual light is a
 * THREE.SpotLight the scene adds — this is only the fixture you see hanging.
 */
export function spotFixture(lib: MatLib, tint: number, aim: THREE.Vector3): Prop {
  // The barrel is authored pointing down and then tilted toward the aim, so a
  // fixture never reads as "pointing at the far wall while lighting the floor".
  const yaw = Math.atan2(aim.x, aim.z);
  const pitch = Math.atan2(Math.hypot(aim.x, aim.z), Math.max(0.2, aim.y));

  const body = merge([
    place(cyl(0.11, 0.13, 0.34, 12), 0, -0.2, 0),
    place(cyl(0.135, 0.135, 0.05, 12), 0, -0.38, 0),
    place(box(0.05, 0.24, 0.05), -0.15, -0.16, 0),
    place(box(0.05, 0.24, 0.05), 0.15, -0.16, 0),
    place(box(0.22, 0.06, 0.12), 0, -0.02, 0),
    place(cyl(0.03, 0.03, 0.1, 8), 0, 0.04, 0),
  ]);
  boxUV(body, 0.3);
  const lens = place(cyl(0.115, 0.115, 0.012, 12), 0, -0.4, 0);

  for (const g of [body, lens]) {
    g.rotateX(pitch);
    g.rotateY(yaw);
  }
  return [
    { geo: body, mat: lib.metal('#22252b', 0.45, 0.8), receive: false },
    { geo: lens, mat: lib.emissive(tint, 5.0), cast: false, receive: false },
  ];
}

/** A line-array style speaker stack. */
export function speakerStack(lib: MatLib, height = 2.2): Prop {
  const boxes: THREE.BufferGeometry[] = [];
  const cones: THREE.BufferGeometry[] = [];
  const cabinets = Math.max(2, Math.round(height / 0.55));
  for (let i = 0; i < cabinets; i++) {
    const y = 0.18 + (height / cabinets) * i;
    const w = 0.72 - i * 0.02;
    boxes.push(place(rbox(w, height / cabinets - 0.03, 0.46, 0.02), 0, y + 0.12, 0));
    cones.push(place(cyl(0.13, 0.13, 0.02, 14).rotateX(Math.PI / 2), -w * 0.2, y + 0.12, 0.235));
    cones.push(place(cyl(0.13, 0.13, 0.02, 14).rotateX(Math.PI / 2), w * 0.2, y + 0.12, 0.235));
  }
  boxes.push(place(box(0.9, 0.18, 0.62), 0, 0.09, 0));
  const geo = merge(boxes);
  boxUV(geo, 0.4);
  return [
    { geo, mat: lib.painted(0x15171b, 0.72) },
    { geo: merge(cones), mat: lib.metal('#4a4f57', 0.5, 0.7) },
  ];
}

/** Crowd barrier: two rails on angled feet. */
export function barrier(lib: MatLib, width = 2.2): Prop {
  const parts: THREE.BufferGeometry[] = [];
  for (const y of [0.55, 1.02]) {
    parts.push(place(cyl(0.026, 0.026, width, 8).rotateZ(Math.PI / 2), 0, y, 0));
  }
  for (const sx of [-1, 1]) {
    parts.push(place(cyl(0.03, 0.034, 1.06, 8), (sx * width) / 2, 0.53, 0));
    parts.push(place(box(0.06, 0.05, 0.62), (sx * width) / 2, 0.025, 0));
  }
  const geo = merge(parts);
  boxUV(geo, 0.4);
  return [{ geo, mat: lib.metal('#9aa1aa', 0.38, 0.85) }];
}

/**
 * A floor mark: a thin plate with a glowing rim. It is 12 mm proud of the
 * floor on purpose — thick enough to catch a shadow edge, thin enough that an
 * avatar standing on it does not float.
 */
export function stageMark(lib: MatLib, w: number, d: number, tint: number): Prop {
  const plate = place(rbox(w, 0.012, d, 0.004), 0, 0.006, 0);
  boxUV(plate, 0.7);
  const rim: THREE.BufferGeometry[] = [];
  const t = 0.07;
  rim.push(place(box(w, 0.014, t), 0, 0.008, -d / 2 + t / 2));
  rim.push(place(box(w, 0.014, t), 0, 0.008, d / 2 - t / 2));
  rim.push(place(box(t, 0.014, d - t * 2), -w / 2 + t / 2, 0.008, 0));
  rim.push(place(box(t, 0.014, d - t * 2), w / 2 - t / 2, 0.008, 0));
  return [
    { geo: plate, mat: lib.painted(0x1b1d22, 0.5), cast: false },
    { geo: merge(rim), mat: lib.emissive(tint, 3.2), cast: false, receive: false },
  ];
}

/** Centre ring for the arena floor. */
export function floorRing(lib: MatLib, radius: number, tint: number): Prop {
  const outer = ringSlab(radius, radius + 0.16, 0.014, 72);
  const inner = ringSlab(radius - 0.7, radius - 0.62, 0.014, 72);
  return [
    { geo: merge([outer, inner]), mat: lib.emissive(tint, 2.6), cast: false, receive: false },
  ];
}

/** Retail display: a lit podium with a glass bell over it. */
export function displayPodium(lib: MatLib, radius = 0.6, tint = 0x2fd8ff): Prop {
  const base = merge([
    place(cyl(radius, radius + 0.05, 0.62, 24), 0, 0.31, 0),
    place(cyl(radius + 0.03, radius + 0.03, 0.05, 24), 0, 0.64, 0),
  ]);
  boxUV(base, 0.5);
  const glow = place(cyl(radius - 0.04, radius - 0.04, 0.012, 24), 0, 0.672, 0);
  const bell = place(cyl(radius - 0.1, radius - 0.06, 0.86, 20, true), 0, 1.11, 0);
  return [
    { geo: base, mat: lib.painted(0x232830, 0.5) },
    { geo: glow, mat: lib.emissive(tint, 3.0), cast: false, receive: false },
    { geo: bell, mat: lib.glass(0x223040, 0.06), cast: false, receive: false },
  ];
}

/** Reception / retail counter with a lit kick strip. */
export function counter(lib: MatLib, width = 3.2, tint = 0x2fd8ff): Prop {
  const h = 1.06, d = 0.72;
  const body = merge([
    place(rbox(width, h - 0.1, d, 0.03), 0, (h - 0.1) / 2 + 0.1, 0),
    place(box(width - 0.1, 0.1, d - 0.1), 0, 0.05, 0),
  ]);
  boxUV(body, 0.6);
  const top = place(rbox(width + 0.12, 0.07, d + 0.16, 0.02), 0, h + 0.035, 0.02);
  boxUV(top, 0.6);
  const strip = place(box(width - 0.2, 0.03, 0.02), 0, 0.14, d / 2 + 0.005);
  return [
    { geo: body, mat: lib.wood('#7d5636') },
    { geo: top, mat: lib.concrete('#cbc5b9') },
    { geo: strip, mat: lib.emissive(tint, 2.4), cast: false, receive: false },
  ];
}

/** Meeting table. */
export function table(lib: MatLib, w = 3.2, d = 1.8): Prop {
  const h = 0.74;
  const top = place(rbox(w, 0.06, d, 0.02), 0, h, 0);
  boxUV(top, 0.6);
  const legs: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    legs.push(place(box(0.09, h - 0.06, d - 0.5), sx * (w / 2 - 0.3), (h - 0.06) / 2, 0));
    legs.push(place(box(0.14, 0.05, d - 0.36), sx * (w / 2 - 0.3), 0.025, 0));
  }
  legs.push(place(box(w - 0.9, 0.08, 0.1), 0, h - 0.2, 0));
  return [
    { geo: top, mat: lib.wood('#b3814f') },
    { geo: merge(legs), mat: lib.metal('#2b2f35', 0.5, 0.8) },
  ];
}

/** Lift doors with a call panel and an indicator. */
export function elevatorDoor(lib: MatLib, width = 2.6, height = 2.5): Prop {
  const frame = merge([
    place(box(width + 0.3, height + 0.24, 0.12), 0, (height + 0.24) / 2, -0.06),
  ]);
  boxUV(frame, 0.6);
  const leaves = merge([
    place(rbox(width / 2 - 0.02, height, 0.06, 0.01), -width / 4, height / 2, 0.02),
    place(rbox(width / 2 - 0.02, height, 0.06, 0.01), width / 4, height / 2, 0.02),
  ]);
  boxUV(leaves, 0.8);
  const call = merge([
    place(box(0.16, 0.3, 0.03), width / 2 + 0.24, 1.15, 0.02),
    place(box(width * 0.4, 0.14, 0.03), 0, height + 0.14, 0.02),
  ]);
  return [
    { geo: frame, mat: lib.concrete('#8f8a82') },
    { geo: leaves, mat: lib.metal('#8d949c', 0.3, 0.9) },
    { geo: call, mat: lib.emissive(0x39d98a, 1.8), cast: false, receive: false },
  ];
}

/** Ring light on a stand — the single most recognisable streamer prop. */
export function ringLight(lib: MatLib, radius = 0.34): Prop {
  const stand = merge([
    place(cyl(0.02, 0.026, 1.42, 8), 0, 0.71, 0),
    place(cyl(0.16, 0.18, 0.03, 12), 0, 0.015, 0),
    place(box(0.05, 0.05, 0.16), 0, 1.43, -0.04),
  ]);
  boxUV(stand, 0.4);
  const ring = new THREE.TorusGeometry(radius, 0.045, 8, 32);
  const glow = new THREE.TorusGeometry(radius, 0.028, 6, 32);
  return [
    { geo: merge([stand, place(ring, 0, 1.62, -0.02)]), mat: lib.metal('#2d3138', 0.45, 0.8) },
    { geo: place(glow, 0, 1.62, 0.005), mat: lib.emissive(0xfff2dc, 4.5), cast: false, receive: false },
  ];
}

/** Broadcast camera on a tripod. */
export function cameraRig(lib: MatLib): Prop {
  const dark: THREE.BufferGeometry[] = [
    place(rbox(0.34, 0.26, 0.52, 0.03), 0, 1.32, 0),          // body
    place(cyl(0.09, 0.11, 0.22, 14), 0, 1.32, 0.32),           // lens barrel
    place(box(0.16, 0.1, 0.14), -0.2, 1.42, -0.02),            // monitor arm
    place(box(0.06, 0.1, 0.16), 0, 1.16, -0.02),               // head
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = cyl(0.018, 0.026, 1.16, 8);
    leg.rotateX(Math.cos(a) * 0.2);
    leg.rotateZ(-Math.sin(a) * 0.2);
    dark.push(place(leg, Math.sin(a) * 0.14, 0.58, Math.cos(a) * 0.14));
  }
  const geo = merge(dark);
  boxUV(geo, 0.35);
  const glass = place(cyl(0.082, 0.082, 0.012, 14).rotateX(Math.PI / 2), 0, 1.32, 0.44);
  const tally = place(box(0.05, 0.03, 0.02), 0.12, 1.47, 0.2);
  return [
    { geo, mat: lib.painted(0x181b20, 0.55) },
    { geo: glass, mat: lib.glass(0x0d1620, 0.05), cast: false },
    { geo: tally, mat: lib.emissive(0xff2222, 4.0), cast: false, receive: false },
  ];
}

/** A boxed neon sign for a wall: outline plus a filled bar. */
export function neonSign(lib: MatLib, tint = 0xff3d9a, w = 1.6, h = 0.6): Prop {
  const t = 0.05;
  const outline = merge([
    place(box(w, t, t), 0, h / 2, 0),
    place(box(w, t, t), 0, -h / 2, 0),
    place(box(t, h, t), -w / 2, 0, 0),
    place(box(t, h, t), w / 2, 0, 0),
    place(box(w * 0.52, t * 0.9, t * 0.9), -w * 0.12, -h * 0.12, 0),
    place(box(w * 0.3, t * 0.9, t * 0.9), w * 0.22, h * 0.14, 0),
  ]);
  const backing = place(box(w + 0.14, h + 0.14, 0.05), 0, 0, -0.06);
  boxUV(backing, 0.4);
  return [
    { geo: backing, mat: lib.painted(0x141519, 0.7), cast: false },
    { geo: outline, mat: lib.emissive(tint, 4.5), cast: false, receive: false },
  ];
}

const BEAM_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vView;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * The cone of light you can see in the air. Not volumetrics: a cone mesh that
 * fades at its rim and its tip, drawn additively with no depth write. It is
 * what makes a stage read as a stage in a still frame, and it costs one draw
 * call per lamp.
 */
const BEAM_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uIntensity;
void main() {
  // uv.y runs from the lamp (1.0) to the floor (0.0) on a cone's side.
  float along = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.75, vUv.y);
  // Rim fade: the silhouette must not end in a hard edge.
  float rim = pow(sin(vUv.x * 3.14159), 0.6);
  gl_FragColor = vec4(uColor * uIntensity * along * rim, along * rim);
}
`;

export function beamMaterial(tint: number, intensity = 0.5): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(tint).convertSRGBToLinear() },
      uIntensity: { value: intensity },
    },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

/** Cone mesh for `beamMaterial`, aimed from `from` at `to`. */
export function beamMesh(mat: THREE.ShaderMaterial, from: THREE.Vector3, to: THREE.Vector3, spread = 0.34) {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = Math.max(0.5, dir.length());
  const geo = new THREE.ConeGeometry(length * spread, length, 20, 1, true);
  // Cones are authored around +Y with the tip up; the lamp is the tip.
  geo.translate(0, -length / 2, 0);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.normalize());
  mesh.frustumCulled = false;
  return mesh;
}
