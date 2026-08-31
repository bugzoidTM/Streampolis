import * as THREE from 'three';
import { fbm, worley, mulberry32 } from '../materials/Noise.js';

/** Skin tones, warm-to-cool, sampled to read well under the daylight rig. */
export const SKIN_TONES = [
  '#f6dcc8', '#f0cdb0', '#e5b596', '#d29b78',
  '#b87d5b', '#95603f', '#6f452c', '#4d2f1e',
] as const;

export const HAIR_COLORS = [
  '#1b1614', '#3a2a20', '#6b452a', '#a8703c',
  '#d9a441', '#e8dcc8', '#8f2f3f', '#2f5fa8',
  '#6b2fa8', '#2fa87e',
] as const;

export const EYE_COLORS = [
  '#3d2b1f', '#6b4a2a', '#4a6b3a', '#3a6b8a', '#5a5a6b', '#2a2a2a',
] as const;

let skinNormalMap: THREE.Texture | null = null;

/** Fine pore/vellus detail. One shared map across every avatar. */
function poreNormal(): THREE.Texture {
  if (skinNormalMap) return skinNormalMap;
  const size = 256;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Pores are a fine cellular pattern; vellus adds high-frequency fuzz.
      h[y * size + x] = worley(u, v, 64, 21) * 0.6 + (fbm(u * 220, v * 220, 3, 64) * 0.5 + 0.5) * 0.4;
    }
  }
  const at = (x: number, y: number) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 3.2;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.needsUpdate = true;
  skinNormalMap = tex;
  return tex;
}

/**
 * Skin. Sheen approximates the forward-scattered rim that makes real skin
 * glow at grazing angles; without it a stylised body reads as painted vinyl.
 * A low clearcoat gives the broad, soft specular of sebum rather than the
 * tight highlight of a dielectric like plastic.
 */
export function makeSkinMaterial(toneIndex: number): THREE.MeshPhysicalMaterial {
  const base = new THREE.Color(SKIN_TONES[toneIndex % SKIN_TONES.length]).convertSRGBToLinear();
  const mat = new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: 0.62,
    metalness: 0.0,
    normalMap: poreNormal(),
    normalScale: new THREE.Vector2(0.22, 0.22),
    sheen: 0.42,
    sheenRoughness: 0.72,
    sheenColor: new THREE.Color('#ff9b7a').convertSRGBToLinear(),
    clearcoat: 0.14,
    clearcoatRoughness: 0.5,
    specularIntensity: 0.45,
    envMapIntensity: 0.9,
  });
  mat.name = 'skin';
  return mat;
}

/**
 * Hair. Real hair is a bundle of cylinders, so its highlight stretches along
 * the strand direction — `anisotropy` reproduces that on a solid sculpt far
 * more cheaply than strand cards would.
 */
export function makeHairMaterial(colorIndex: number): THREE.MeshPhysicalMaterial {
  const base = new THREE.Color(HAIR_COLORS[colorIndex % HAIR_COLORS.length]).convertSRGBToLinear();
  const mat = new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: 0.38,
    metalness: 0.0,
    anisotropy: 0.85,
    anisotropyRotation: Math.PI * 0.5,
    sheen: 0.55,
    sheenRoughness: 0.35,
    sheenColor: base.clone().lerp(new THREE.Color(1, 1, 1), 0.4),
    clearcoat: 0.35,
    clearcoatRoughness: 0.28,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
  });
  mat.name = 'hair';
  return mat;
}

let irisCache = new Map<string, THREE.Texture>();

/** Radial iris with a fibrous stroma and a dark limbal ring. */
function irisTexture(color: string): THREE.Texture {
  const hit = irisCache.get(color);
  if (hit) return hit;
  const size = 128;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = (canvas as HTMLCanvasElement).getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const c = new THREE.Color(color);
  const rnd = mulberry32(color.length * 99991);
  const fibres = Array.from({ length: 90 }, () => rnd());

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x / size - 0.5;
      const dy = y / size - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const a = Math.atan2(dy, dx);
      const i = (y * size + x) * 4;

      if (r > 1) { img.data[i + 3] = 0; continue; }

      // Pupil.
      if (r < 0.36) {
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 6;
        img.data[i + 3] = 255;
        continue;
      }
      // Limbal ring darkens the outer edge, which reads as depth.
      const limbal = r > 0.86 ? THREE.MathUtils.smoothstep(r, 0.86, 1.0) : 0;
      const fibre = fibres[Math.floor(((a + Math.PI) / (Math.PI * 2)) * fibres.length) % fibres.length];
      const radial = 0.7 + fibre * 0.6 * (1 - Math.abs(r - 0.62) / 0.4);
      const shade = Math.max(0, radial * (1 - limbal * 0.85));
      img.data[i] = c.r * 255 * shade;
      img.data[i + 1] = c.g * 255 * shade;
      img.data[i + 2] = c.b * 255 * shade;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  irisCache.set(color, tex);
  return tex;
}

export function makeIrisMaterial(colorIndex: number): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map: irisTexture(EYE_COLORS[colorIndex % EYE_COLORS.length]),
    roughness: 0.30,
    metalness: 0,
    // A full-strength clearcoat over the whole iris washed every eye colour
    // to the same grey. The wet look belongs on the cornea, and the catch
    // light already plays that part.
    clearcoat: 0.20,
    clearcoatRoughness: 0.06,
    // The sky dome is blue, and any real amount of environment reflection on
    // a surface this small turns every eye colour into the same blue-grey.
    envMapIntensity: 0.22,
    transparent: true,
  });
}

export function makeScleraMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    // Not white: a real sclera is a shaded, slightly warm grey, and pure
    // white next to a dark iris is what makes an eye read as a cartoon decal.
    color: new THREE.Color('#ddd8d4').convertSRGBToLinear(),
    roughness: 0.18,
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.05,
    sheen: 0.2,
    envMapIntensity: 0.8,
  });
}

/**
 * Lips. Derived from the skin tone rather than picked from a palette, so a
 * dark-skinned avatar does not get a pale mouth pasted on: same hue family,
 * pushed redder and darker, and wet enough to catch a highlight of its own.
 */
export function makeLipMaterial(toneIndex: number): THREE.MeshPhysicalMaterial {
  const hsl = { h: 0, s: 0, l: 0 };
  new THREE.Color(SKIN_TONES[toneIndex % SKIN_TONES.length]).getHSL(hsl);
  // A small nudge, not lipstick: pushed a third of the way toward red and a
  // quarter darker. The first pass multiplied saturation by 1.35 and every
  // avatar came out wearing orange gloss.
  const lip = new THREE.Color().setHSL(
    hsl.h * 0.94,
    Math.min(1, hsl.s * 1.10 + 0.03),
    Math.max(0.08, hsl.l * 0.84),
  ).convertSRGBToLinear();

  return new THREE.MeshPhysicalMaterial({
    color: lip,
    roughness: 0.36,
    metalness: 0,
    sheen: 0.5,
    sheenRoughness: 0.5,
    clearcoat: 0.45,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.1,
  });
}

/** The inside of a mouth, and the pupil: things that swallow light. */
export function makeMouthMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color('#160d10').convertSRGBToLinear(),
    roughness: 0.75,
    metalness: 0,
  });
}

/**
 * The catch light. Unlit on purpose: a real one is a reflection of the key
 * light, and faking it with a lit material means it dies in every scene whose
 * key does not happen to point at the eye — which is most of a live.
 */
export function makeHighlightMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
}

export interface ClothOptions {
  color: string;
  roughness?: number;
  sheen?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}

/** Generic garment material; the weave normal comes from the shared surface. */
export function makeClothMaterial(o: ClothOptions): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(o.color).convertSRGBToLinear(),
    roughness: o.roughness ?? 0.82,
    metalness: o.metalness ?? 0,
    sheen: o.sheen ?? 0.3,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(o.color).convertSRGBToLinear().lerp(new THREE.Color(1, 1, 1), 0.55),
    envMapIntensity: 0.85,
  });
  if (o.emissive) {
    mat.emissive = new THREE.Color(o.emissive).convertSRGBToLinear();
    mat.emissiveIntensity = o.emissiveIntensity ?? 1;
  }
  return mat;
}

export function disposeAvatarMaterialCache() {
  skinNormalMap?.dispose();
  skinNormalMap = null;
  for (const t of irisCache.values()) t.dispose();
  irisCache = new Map();
}
