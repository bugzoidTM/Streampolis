/** Deterministic value/gradient noise used by every procedural texture. */

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = new Uint8Array(512);
{
  const rnd = mulberry32(1337);
  const perm = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 512; i++) P[i] = perm[i & 255];
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function grad(hash: number, x: number, y: number) {
  switch (hash & 3) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    default: return -x - y;
  }
}

/** Classic 2D Perlin, output in roughly [-1, 1]. */
export function perlin2(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const aa = P[P[xi] + yi];
  const ab = P[P[xi] + yi + 1];
  const ba = P[P[xi + 1] + yi];
  const bb = P[P[xi + 1] + yi + 1];
  return lerp(
    lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
    lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u),
    v,
  );
}

/** Tileable Perlin: samples a torus so the texture wraps without a seam. */
export function perlinTileable(x: number, y: number, period: number): number {
  const px = x % period;
  const py = y % period;
  const a = perlin2(px, py);
  const b = perlin2(px - period, py);
  const c = perlin2(px, py - period);
  const d = perlin2(px - period, py - period);
  const fx = px / period;
  const fy = py / period;
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

export function fbm(x: number, y: number, octaves = 5, period = 64, gain = 0.5, lacunarity = 2): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += perlinTileable(x * freq, y * freq, period * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise — the sharp creases that read as grain, cracks or fibres. */
export function ridged(x: number, y: number, octaves = 4, period = 64): number {
  let sum = 0, amp = 1, norm = 0, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += (1 - Math.abs(perlinTileable(x * freq, y * freq, period * freq))) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Tileable Worley/cellular noise; returns distance to the nearest feature. */
export function worley(x: number, y: number, cells: number, seed = 7): number {
  const cx = Math.floor(x * cells);
  const cy = Math.floor(y * cells);
  let best = 1e9;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      const gx = ((cx + ox) % cells + cells) % cells;
      const gy = ((cy + oy) % cells + cells) % cells;
      const rnd = mulberry32(gx * 73856093 ^ gy * 19349663 ^ seed);
      const fx = (cx + ox + rnd()) / cells;
      const fy = (cy + oy + rnd()) / cells;
      const dx = x - fx;
      const dy = y - fy;
      best = Math.min(best, dx * dx + dy * dy);
    }
  }
  return Math.sqrt(best) * cells;
}
