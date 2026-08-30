import * as THREE from 'three';
import { fbm, ridged, worley, mulberry32 } from './Noise.js';

/**
 * Procedural PBR texture bakery. Every map in the MVP is generated at runtime
 * into an OffscreenCanvas, which keeps the first-play download budget
 * (SPECs §44) at essentially zero for surfaces while still giving materials
 * real albedo / normal / roughness variation.
 *
 * Maps are cached by key so a material used across a hundred instances bakes
 * once. Generation is deterministic, so the same key always yields the
 * same pixels.
 */

type Rgb = [number, number, number];

export interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  /** Baked cavity AO, multiplied into the ambient term. */
  aoMap: THREE.Texture;
}

const cache = new Map<string, SurfaceMaps>();
let anisotropy = 8;

export function setTextureAnisotropy(value: number) { anisotropy = value; }

function makeCanvas(size: number): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(size, size);
    return { canvas: c, ctx: c.getContext('2d') as unknown as CanvasRenderingContext2D };
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return { canvas: c, ctx: c.getContext('2d')! };
}

function toTexture(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  { srgb, repeat }: { srgb: boolean; repeat: number },
): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Derives a tangent-space normal map from a height field by central
 * differences. Wrapping the sample indices keeps the result seamless.
 */
function heightToNormal(height: Float32Array, size: number, strength: number): ImageData {
  const out = new ImageData(size, size);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // n = normalize(-dx, -dy, 1) packed into [0,1].
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      out.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/** Cheap screen-space-free cavity AO: darkens local height minima. */
function heightToAo(height: Float32Array, size: number, strength: number): ImageData {
  const out = new ImageData(size, size);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let o = 1; o <= 3; o++) {
        sum += at(x + o, y) + at(x - o, y) + at(x, y + o) + at(x, y - o);
      }
      const avg = sum / 12;
      const cavity = Math.max(0, avg - at(x, y));
      const ao = Math.max(0, Math.min(1, 1 - cavity * strength));
      const v = ao * 255;
      const i = (y * size + x) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

interface SurfaceRecipe {
  /** Height in [0,1] at normalised uv. */
  height: (u: number, v: number, rnd: () => number) => number;
  /** Albedo colour at uv, given the height already computed there. */
  albedo: (u: number, v: number, h: number) => Rgb;
  /** Perceptual roughness at uv. */
  roughness: (u: number, v: number, h: number) => number;
  normalStrength: number;
  aoStrength: number;
}

function bake(key: string, size: number, repeat: number, recipe: SurfaceRecipe): SurfaceMaps {
  const hit = cache.get(key);
  if (hit) return hit;

  const height = new Float32Array(size * size);
  const albedo = makeCanvas(size);
  const rough = makeCanvas(size);
  const albedoData = new ImageData(size, size);
  const roughData = new ImageData(size, size);
  const rnd = mulberry32(key.length * 2654435761);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const h = recipe.height(u, v, rnd);
      height[y * size + x] = h;

      const [r, g, b] = recipe.albedo(u, v, h);
      const i = (y * size + x) * 4;
      albedoData.data[i] = r * 255;
      albedoData.data[i + 1] = g * 255;
      albedoData.data[i + 2] = b * 255;
      albedoData.data[i + 3] = 255;

      const rr = Math.max(0, Math.min(1, recipe.roughness(u, v, h))) * 255;
      roughData.data[i] = roughData.data[i + 1] = roughData.data[i + 2] = rr;
      roughData.data[i + 3] = 255;
    }
  }

  albedo.ctx.putImageData(albedoData, 0, 0);
  rough.ctx.putImageData(roughData, 0, 0);

  const normal = makeCanvas(size);
  normal.ctx.putImageData(heightToNormal(height, size, recipe.normalStrength), 0, 0);
  const ao = makeCanvas(size);
  ao.ctx.putImageData(heightToAo(height, size, recipe.aoStrength), 0, 0);

  const maps: SurfaceMaps = {
    map: toTexture(albedo.canvas, { srgb: true, repeat }),
    normalMap: toTexture(normal.canvas, { srgb: false, repeat }),
    roughnessMap: toTexture(rough.canvas, { srgb: false, repeat }),
    aoMap: toTexture(ao.canvas, { srgb: false, repeat }),
  };
  cache.set(key, maps);
  return maps;
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const hexRgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace('#', ''), 16);
  // Textures feed a linear pipeline through an sRGB-tagged canvas, so the
  // plain 0..1 split here is already the right space.
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// --------------------------------------------------------------------------
// Surface library
// --------------------------------------------------------------------------

export function woodFloor(size = 512, repeat = 6, tint = '#a9714b'): SurfaceMaps {
  const base = hexRgb(tint);
  const dark = mix(base, [0.12, 0.07, 0.04], 0.55);
  const plankW = 1 / 7;
  return bake(`wood-${tint}-${repeat}`, size, repeat, {
    normalStrength: 34, aoStrength: 2.4,
    height: (u, v) => {
      const row = Math.floor(v / plankW);
      // Stagger every other course so joints do not line up.
      const off = (row % 2) * 0.5;
      const su = (u + off) % 1;
      const plankIdx = Math.floor(su * 4);
      const grain = ridged(su * 90 + plankIdx * 31, v * 8 + row * 17, 4, 64);
      const seamV = Math.min(v / plankW % 1, 1 - (v / plankW % 1));
      const seamU = Math.min(su * 4 % 1, 1 - (su * 4 % 1));
      const seam = Math.min(seamV, seamU * 0.6);
      const joint = 1 - Math.exp(-seam * 130);
      return grain * 0.28 + joint * 0.72;
    },
    albedo: (u, v, h) => {
      const row = Math.floor(v / plankW);
      const off = (row % 2) * 0.5;
      const su = (u + off) % 1;
      const plankIdx = Math.floor(su * 4) + row * 4;
      // Per-plank tonal variation is what stops wood reading as wallpaper.
      const tone = 0.82 + (mulberry32(plankIdx * 2654435761)() * 0.36);
      const c = mix(dark, base, 0.35 + h * 0.65);
      return [c[0] * tone, c[1] * tone, c[2] * tone];
    },
    roughness: (_u, _v, h) => 0.42 + (1 - h) * 0.34,
  });
}

export function concrete(size = 512, repeat = 8, tint = '#9a9a9b'): SurfaceMaps {
  const base = hexRgb(tint);
  return bake(`concrete-${tint}-${repeat}`, size, repeat, {
    normalStrength: 12, aoStrength: 1.6,
    height: (u, v) => {
      const grit = fbm(u * 140, v * 140, 5, 64) * 0.5 + 0.5;
      const blotch = fbm(u * 14, v * 14, 4, 16) * 0.5 + 0.5;
      const pit = worley(u, v, 24, 3) > 0.14 ? 0 : -0.35;
      return grit * 0.35 + blotch * 0.65 + pit;
    },
    albedo: (u, v, h) => {
      const stain = fbm(u * 6, v * 6, 3, 8) * 0.5 + 0.5;
      const c = mix(mix(base, [0.36, 0.36, 0.38], 0.4), base, 0.3 + h * 0.7);
      return mix(c, mix(c, [0.5, 0.5, 0.52], 0.35), stain * 0.5);
    },
    roughness: (u, v, h) => 0.78 + (1 - h) * 0.16 + fbm(u * 30, v * 30, 2, 32) * 0.05,
  });
}

export function pavingTile(size = 512, repeat = 10, tint = '#b9b3aa', grout = '#5f5b55'): SurfaceMaps {
  const base = hexRgb(tint);
  const groutC = hexRgb(grout);
  const n = 4; // tiles per texture side
  return bake(`paving-${tint}-${repeat}`, size, repeat, {
    normalStrength: 46, aoStrength: 3.0,
    height: (u, v) => {
      const fu = (u * n) % 1;
      const fv = (v * n) % 1;
      const d = Math.min(fu, 1 - fu, fv, 1 - fv);
      const bevel = Math.min(1, d / 0.045);
      const grit = fbm(u * 180, v * 180, 4, 64) * 0.06;
      const wear = fbm(u * 20, v * 20, 3, 24) * 0.05;
      return bevel * 0.9 + grit + wear;
    },
    albedo: (u, v, h) => {
      const tu = Math.floor(u * n);
      const tv = Math.floor(v * n);
      const tone = 0.88 + mulberry32(tu * 374761393 ^ tv * 668265263)() * 0.24;
      const speck = fbm(u * 260, v * 260, 3, 64) * 0.5 + 0.5;
      const stone = mix(base, [speck * 0.9, speck * 0.88, speck * 0.84], 0.22);
      const c: Rgb = [stone[0] * tone, stone[1] * tone, stone[2] * tone];
      return mix(groutC, c, Math.min(1, h * 1.4));
    },
    roughness: (_u, _v, h) => 0.62 + (1 - h) * 0.3,
  });
}

export function brick(size = 512, repeat = 6, tint = '#9c5340'): SurfaceMaps {
  const base = hexRgb(tint);
  const mortar = hexRgb('#b9b2a6');
  const rows = 8;
  const cols = 4;
  return bake(`brick-${tint}-${repeat}`, size, repeat, {
    normalStrength: 60, aoStrength: 3.4,
    height: (u, v) => {
      const row = Math.floor(v * rows);
      const su = (u + (row % 2) * 0.5 / cols) % 1;
      const fu = (su * cols) % 1;
      const fv = (v * rows) % 1;
      const d = Math.min(fu, 1 - fu, fv * 1.6, (1 - fv) * 1.6);
      const bevel = Math.min(1, d / 0.09);
      const rough = fbm(u * 200, v * 200, 4, 64) * 0.08;
      return bevel * 0.88 + rough;
    },
    albedo: (u, v, h) => {
      const row = Math.floor(v * rows);
      const su = (u + (row % 2) * 0.5 / cols) % 1;
      const col = Math.floor(su * cols);
      const rnd = mulberry32(row * 73856093 ^ col * 19349663);
      const tone = 0.74 + rnd() * 0.5;
      const hue = mix(base, [0.42, 0.24, 0.2], rnd() * 0.45);
      const c: Rgb = [hue[0] * tone, hue[1] * tone, hue[2] * tone];
      return mix(mortar, c, Math.min(1, h * 1.5));
    },
    roughness: (_u, _v, h) => 0.8 + (1 - h) * 0.14,
  });
}

export function fabric(size = 256, repeat = 4, tint = '#4a5a78', weave = 120): SurfaceMaps {
  const base = hexRgb(tint);
  return bake(`fabric-${tint}-${repeat}-${weave}`, size, repeat, {
    normalStrength: 22, aoStrength: 2.2,
    height: (u, v) => {
      // Over-under weave: two phase-shifted sine ridges, gated by parity.
      const wu = Math.sin(u * weave * Math.PI * 2) * 0.5 + 0.5;
      const wv = Math.sin(v * weave * Math.PI * 2) * 0.5 + 0.5;
      const over = (Math.floor(u * weave) + Math.floor(v * weave)) % 2 === 0;
      const w = over ? wu : wv;
      const fuzz = fbm(u * 300, v * 300, 3, 64) * 0.12;
      return w * 0.8 + fuzz;
    },
    albedo: (u, v, h) => {
      const shade = 0.78 + h * 0.34;
      const slub = fbm(u * 40, v * 40, 3, 32) * 0.08;
      return [base[0] * shade + slub, base[1] * shade + slub, base[2] * shade + slub];
    },
    roughness: (_u, _v, h) => 0.86 - h * 0.08,
  });
}

export function carpet(size = 256, repeat = 8, tint = '#6d5f57'): SurfaceMaps {
  const base = hexRgb(tint);
  return bake(`carpet-${tint}-${repeat}`, size, repeat, {
    normalStrength: 16, aoStrength: 2.8,
    height: (u, v) => {
      const pile = worley(u, v, 90, 11);
      const fuzz = fbm(u * 240, v * 240, 4, 64) * 0.5 + 0.5;
      return pile * 0.55 + fuzz * 0.45;
    },
    albedo: (u, v, h) => {
      const shade = 0.72 + h * 0.5;
      return [base[0] * shade, base[1] * shade, base[2] * shade];
    },
    roughness: () => 0.95,
  });
}

export function plaster(size = 256, repeat = 3, tint = '#e6e1d8'): SurfaceMaps {
  const base = hexRgb(tint);
  return bake(`plaster-${tint}-${repeat}`, size, repeat, {
    normalStrength: 8, aoStrength: 1.2,
    height: (u, v) => {
      const trowel = fbm(u * 9, v * 9, 4, 16) * 0.5 + 0.5;
      const grain = fbm(u * 160, v * 160, 3, 64) * 0.18;
      return trowel * 0.82 + grain;
    },
    albedo: (u, v, h) => {
      const shade = 0.94 + h * 0.1;
      return [base[0] * shade, base[1] * shade, base[2] * shade];
    },
    roughness: (_u, _v, h) => 0.9 - h * 0.06,
  });
}

export function slatWall(size = 512, repeat = 4, tint = '#8a6647'): SurfaceMaps {
  const base = hexRgb(tint);
  const slats = 18;
  return bake(`slat-${tint}-${repeat}`, size, repeat, {
    normalStrength: 70, aoStrength: 4.0,
    height: (u, v) => {
      const f = (u * slats) % 1;
      // Rounded slat profile with a deep shadow gap between courses.
      const profile = Math.sin(Math.min(1, Math.max(0, (f - 0.08) / 0.84)) * Math.PI);
      const gap = f < 0.08 ? 0 : 1;
      const grain = ridged(u * 200, v * 12, 3, 64) * 0.1;
      return profile * gap * 0.9 + grain;
    },
    albedo: (u, v, h) => {
      const idx = Math.floor(u * slats);
      const tone = 0.86 + mulberry32(idx * 2654435761)() * 0.24;
      const c = mix(mix(base, [0.1, 0.06, 0.04], 0.6), base, Math.min(1, h * 1.3));
      return [c[0] * tone, c[1] * tone, c[2] * tone];
    },
    roughness: (_u, _v, h) => 0.5 + (1 - h) * 0.3,
  });
}

export function metalPanel(size = 256, repeat = 4, tint = '#8e939b'): SurfaceMaps {
  const base = hexRgb(tint);
  return bake(`metal-${tint}-${repeat}`, size, repeat, {
    normalStrength: 10, aoStrength: 1.0,
    height: (u, v) => {
      // Anisotropic brushing: high frequency across, smooth along.
      const brush = fbm(u * 400, v * 6, 3, 64) * 0.5 + 0.5;
      const dent = fbm(u * 12, v * 12, 3, 16) * 0.12;
      return brush * 0.8 + dent + 0.1;
    },
    albedo: (_u, _v, h) => [base[0] * (0.9 + h * 0.2), base[1] * (0.9 + h * 0.2), base[2] * (0.9 + h * 0.2)],
    roughness: (u, v, h) => 0.24 + h * 0.16 + fbm(u * 20, v * 20, 2, 24) * 0.04,
  });
}

export function asphalt(size = 512, repeat = 12): SurfaceMaps {
  return bake('asphalt', size, repeat, {
    normalStrength: 20, aoStrength: 2.0,
    height: (u, v) => {
      const agg = worley(u, v, 60, 5);
      const grit = fbm(u * 200, v * 200, 4, 64) * 0.3;
      return agg * 0.6 + grit + 0.2;
    },
    albedo: (u, v, h) => {
      const g = 0.11 + h * 0.13 + (fbm(u * 40, v * 40, 3, 32) * 0.5 + 0.5) * 0.05;
      return [g, g * 1.01, g * 1.04];
    },
    roughness: (_u, _v, h) => 0.88 - h * 0.1,
  });
}

/** Applies a baked surface to a standard material with sane defaults. */
export function applySurface(
  mat: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial,
  maps: SurfaceMaps,
  { normalScale = 1, repeat }: { normalScale?: number; repeat?: number } = {},
) {
  mat.map = maps.map;
  mat.normalMap = maps.normalMap;
  mat.roughnessMap = maps.roughnessMap;
  mat.aoMap = maps.aoMap;
  mat.normalScale = new THREE.Vector2(normalScale, normalScale);
  if (repeat !== undefined) {
    for (const t of [mat.map, mat.normalMap, mat.roughnessMap, mat.aoMap]) {
      t!.repeat.set(repeat, repeat);
    }
  }
  mat.needsUpdate = true;
  return mat;
}

export function disposeTextureCache() {
  for (const maps of cache.values()) {
    for (const t of Object.values(maps)) (t as THREE.Texture).dispose();
  }
  cache.clear();
}
