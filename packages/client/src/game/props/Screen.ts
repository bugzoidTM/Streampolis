import * as THREE from 'three';
import type { MatLib } from './Materials.js';
import { box, boxUV, cyl, merge, place } from './Geometry.js';

/**
 * Animated LED surfaces.
 *
 * Streampolis is a game about broadcasting, so every public space needs a
 * screen that is visibly *playing* something. A texture would be a still
 * frame; a 40-line fragment shader costs one draw call, no memory, and moves.
 * Output is deliberately above 1.0 so the bloom pass blooms it.
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uGain;
uniform vec3 uA;
uniform vec3 uB;
uniform float uBars;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec2 uv = vUv;
  // Rolling diagonal wash between the two brand colours.
  float wave = sin((uv.x * 2.4 + uv.y * 1.1) * 3.14159 - uTime * 0.55) * 0.5 + 0.5;
  vec3 col = mix(uA, uB, wave);

  // Soft vignette so the panel does not read as a flat rectangle of light.
  float r = length((uv - 0.5) * vec2(1.7, 1.0));
  col *= 1.0 - r * 0.45;

  // Audio-meter bars along the lower third.
  if (uBars > 0.5) {
    float cols = 24.0;
    float i = floor(uv.x * cols);
    float h = 0.08 + 0.34 * (0.5 + 0.5 * sin(uTime * (2.0 + hash(i) * 4.0) + i));
    float bar = step(uv.y, h) * step(0.06, fract(uv.x * cols));
    col += bar * mix(uB, vec3(1.0), 0.45) * 0.9;
  }

  // Highlight sweep, like a lower-third animation looping.
  float sweep = smoothstep(0.06, 0.0, abs(uv.y - fract(uTime * 0.11) * 1.2 + 0.1));
  col += sweep * 0.35;

  // Scanlines and pixel grid keep it reading as an LED wall up close.
  float scan = 0.92 + 0.08 * sin(uv.y * 620.0);
  float grid = 0.94 + 0.06 * sin(uv.x * 900.0);
  gl_FragColor = vec4(col * scan * grid * uGain, 1.0);
}
`;

export function screenMaterial(a: number, b: number, gain = 2.1, bars = true): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGain: { value: gain },
      uA: { value: new THREE.Color(a).convertSRGBToLinear() },
      uB: { value: new THREE.Color(b).convertSRGBToLinear() },
      uBars: { value: bars ? 1 : 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: true,
  });
}

export interface VideoWallOpts {
  width: number;
  height: number;
  /** Height of the screen's bottom edge above the ground. */
  base: number;
  colors?: [number, number];
  gain?: number;
  bars?: boolean;
  /** Adds a truss mast and back-stays; off for wall-mounted panels. */
  freestanding?: boolean;
}

/** A framed LED wall with its own animation clock. */
export class VideoWall {
  readonly group = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private geos: THREE.BufferGeometry[] = [];

  constructor(lib: MatLib, opts: VideoWallOpts) {
    const { width: W, height: H, base } = opts;
    const [a, b] = opts.colors ?? [0xff3d7f, 0x2f7bff];
    this.mat = screenMaterial(a, b, opts.gain ?? 2.1, opts.bars ?? true);

    const panel = new THREE.PlaneGeometry(W, H);
    const screen = new THREE.Mesh(panel, this.mat);
    screen.position.set(0, base + H / 2, 0.06);
    this.group.add(screen);
    this.geos.push(panel);

    const frameParts = [
      place(box(W + 0.34, 0.28, 0.34), 0, base + H + 0.14, 0),
      place(box(W + 0.34, 0.28, 0.34), 0, base - 0.14, 0),
      place(box(0.28, H + 0.56, 0.34), -W / 2 - 0.17, base + H / 2, 0),
      place(box(0.28, H + 0.56, 0.34), W / 2 + 0.17, base + H / 2, 0),
      place(box(W, H, 0.12), 0, base + H / 2, -0.06),
    ];
    if (opts.freestanding) {
      for (const sx of [-1, 1]) {
        frameParts.push(place(box(0.34, base + 0.2, 0.34), sx * (W / 2 - 0.4), (base + 0.2) / 2, 0));
        frameParts.push(place(cyl(0.06, 0.06, base * 1.15, 8), sx * (W / 2 - 0.4), base * 0.5, -0.9, 0.5, 0, 0));
        frameParts.push(place(box(1.2, 0.16, 1.6), sx * (W / 2 - 0.4), 0.08, -0.4));
      }
      frameParts.push(place(box(W - 0.4, 0.24, 0.24), 0, base * 0.62, -0.1));
    }
    const frame = merge(frameParts);
    boxUV(frame, 0.7);
    const frameMesh = new THREE.Mesh(frame, lib.metal('#2c3037', 0.55, 0.8));
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;
    this.group.add(frameMesh);
    this.geos.push(frame);
  }

  update(dt: number) { this.mat.uniforms.uTime.value += dt; }

  dispose() {
    this.mat.dispose();
    for (const g of this.geos) g.dispose();
  }
}
