import * as THREE from 'three';
import { loft, assemble, mergeGeometries, type Station } from './Loft.js';
import { BONE_INDEX, type BuiltRig } from './Skeleton.js';
import { type FaceShape, skullPoint, headRadius, headCentre } from './BodyBuilder.js';
import { makeHairMaterial } from './Materials.js';

/**
 * Hair System v2.
 *
 * The old hair was one shell offset from a plain sphere. Two things were wrong
 * with that and both were fatal: the shell ignored the head sculpt, so it slid
 * off the skull the moment a face preset reshaped it, and a single shell has
 * no strands — it reads as a swim cap however it is carved.
 *
 * A style here is built from five parts, which is how hair actually reads at
 * this scale:
 *
 *   base     the scalp cap, laid ON the sculpted skull;
 *   locks    main strands with real thickness, sitting proud of the base;
 *   fringe   what falls over the forehead;
 *   sides    what frames the face;
 *   back     the volume behind, which is most of the silhouette.
 *
 * All of it merges into ONE geometry, so a style with thirty strands still
 * costs one draw call. Hair is the most-bought item in the genre and the one
 * this project was weakest at, so it is worth the file.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const smooth = (e0: number, e1: number, x: number) => THREE.MathUtils.smoothstep(x, e0, e1);

/**
 * Scalp coverage at a direction: 1 where the style has full hair, 0 on bare
 * skin. Normalised rather than absolute so the cap can decide, from coverage
 * alone, where to tuck itself under the skin.
 */
type CapMask = (n: THREE.Vector3) => number;

interface StyleContext {
  R: number;
  face: FaceShape;
}

interface HairStyle {
  base: CapMask;
  /** Cap thickness in head radii where coverage is 1. */
  thickness: number;
  /** Everything that is not the cap: locks, fringe, sides, back volume. */
  locks?: (ctx: StyleContext) => Station[][];
}

// --------------------------------------------------------------------------
// Strand builders
// --------------------------------------------------------------------------

/**
 * A lock of hair. It starts on the scalp at `from`, leaves along `sweep`, and
 * tapers over `length`. `sag` bends it downward as it goes, which is the whole
 * difference between hair and a set of horns.
 */
function lock(
  ctx: StyleContext,
  from: THREE.Vector3,
  sweep: THREE.Vector3,
  opts: {
    length: number; thick: number; sag?: number; taper?: number; wave?: number; steps?: number;
    /** Afastamento do couro cabeludo, em raios de cabeça. */
    lift?: number;
    /**
     * Achatamento da seção: largura sobre profundidade.
     *
     * 1 é um tubo, e tubo é a razão de a franja ler como um punhado de FIOS
     * DE ARAME encostados na testa. Cabelo não se agrupa em cilindros de 6 mm;
     * se agrupa em mechas CHATAS de dois a três centímetros de largura, que se
     * sobrepõem e terminam em ponta. Com 2 a 3 aqui, as mesmas mechas viram
     * massa — e sem um triângulo a mais, porque só os raios mudam.
     */
    flat?: number;
  },
): Station[] {
  const { R, face } = ctx;
  const root = skullPoint(from, R, face, opts.lift ?? 0.012);
  const dir = sweep.clone().normalize();
  const steps = opts.steps ?? 5;
  const sag = opts.sag ?? 0.6;
  const taper = opts.taper ?? 0.35;
  const wave = opts.wave ?? 0;
  const side = new THREE.Vector3().crossVectors(dir, V(0, 1, 0)).normalize();

  const out: Station[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = root.clone()
      .addScaledVector(dir, opts.length * R * t)
      // Gravity accumulates with the square of the distance travelled, which
      // is what makes a lock curve instead of sticking out straight.
      .addScaledVector(V(0, -1, 0), opts.length * R * sag * t * t)
      .addScaledVector(side, Math.sin(t * Math.PI * 2) * wave * R);
    out.push({
      pos: p,
      radiusX: opts.thick * R * (opts.flat ?? 1) * (1 - taper * t),
      radiusZ: opts.thick * R * 0.78 * (1 - taper * t),
      bone: 'Head',
      squareness: 2.4,
    });
  }
  return out;
}

/** A row of locks fanned across an arc of the hairline. */
function fan(
  ctx: StyleContext,
  count: number,
  arc: { fromX: number; toX: number; y: number; z: number },
  sweep: (u: number) => THREE.Vector3,
  opts: {
    length: number; thick: number; sag?: number; wave?: number; jitter?: number;
    taper?: number; lift?: number; flat?: number;
  },
): Station[][] {
  const out: Station[][] = [];
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0.5 : i / (count - 1);
    const x = THREE.MathUtils.lerp(arc.fromX, arc.toX, u);
    // A little irregularity: perfectly even strands read as a wig stand.
    const j = opts.jitter ? Math.sin(i * 12.9898) * opts.jitter : 0;
    // A raiz anda POUCO e o comprimento anda MUITO. Mexer na raiz sobe a linha
    // do cabelo e abre testa; mexer no comprimento é o que faz duas mechas
    // vizinhas terminarem em alturas diferentes, que é o efeito procurado.
    out.push(lock(ctx, V(x, arc.y + j * 0.25, arc.z), sweep(u), {
      length: opts.length * (1 + j * 2.2),
      thick: opts.thick,
      sag: opts.sag,
      wave: opts.wave,
      taper: opts.taper,
      flat: opts.flat,
      // Camadas escalonadas. Mechas deitadas na mesma distância do crânio se
      // fundem numa casca lisa — o capacete de novo, só que feito de trinta
      // peças. Três alturas alternadas e cada ponta passa a se recortar contra
      // a mecha de trás, que é o que faz a franja ler como cabelo.
      lift: (opts.lift ?? 0.010) + (i % 3) * 0.013,
    }));
  }
  return out;
}

/**
 * A draped strand: it follows the skull down while there is skull to follow,
 * then falls free of it.
 *
 * The obvious version — start on the scalp and drop straight down — buries the
 * whole strand inside the head, because the skull keeps widening below the
 * crown. That is why the first back volume was invisible from behind: it was
 * all in there.
 *
 * `length` is arc length in head radii, so a bob and a waist-length style are
 * quoted in the same unit.
 */
function drape(
  ctx: StyleContext,
  opts: {
    /** Horizontal direction the strand hangs on; need not be normalised. */
    dir: THREE.Vector3;
    /** Height on the unit sphere where it leaves the crown, -1..1. */
    startY: number;
    length: number;
    thick: number;
    /** Clearance off the skull, in head radii. */
    clear?: number;
    /** Backward drift once it is falling free. */
    sway?: number;
    /**
     * Height at which the strand stops following the skull. A curtain hugs
     * all the way to the jaw; a ponytail leaves at the band and hangs behind
     * the head, and forcing it to hug produced a tail painted on the occiput.
     */
    hugTo?: number;
    /**
     * How far the free part swings clear of the skull, in head radii. A tail
     * leaving high on the crown has to clear a skull that keeps widening below
     * it, or it falls straight through the head.
     */
    push?: number;
    steps?: number;
    taper?: number;
    /** Largura sobre profundidade da seção; ver `lock`. */
    flat?: number;
    /** Per-t thickness multiplier, for braids and other shaped locks. */
    shape?: (t: number) => number;
  },
): Station[] {
  const { R, face } = ctx;
  const horiz = opts.dir.clone().setY(0).normalize();
  // Folga mínima de uma mecha ao crânio. Era 0,02 R (≈4 mm): mecha a essa
  // distância se funde à touca e o conjunto vira uma peça só — o capacete
  // outra vez, agora feito de trinta partes.
  const clear = opts.clear ?? 0.042;
  const steps = opts.steps ?? 9;
  const taper = opts.taper ?? 0.3;
  // The jaw line, not the pole. Following the skull all the way down converges
  // on the chin — the horizontal radius goes to zero there — so the strand
  // then fell straight through the neck and torso and vanished. Every long
  // style came out neck-length because of it.
  const endY = opts.hugTo ?? -0.58;
  const push = opts.push ?? 0;

  // How much of the length is spent hugging the skull, as arc on the sphere.
  const hugArc = Math.max(0, Math.acos(THREE.MathUtils.clamp(endY, -1, 1))
    - Math.acos(THREE.MathUtils.clamp(opts.startY, -1, 1)));
  const hugFrac = Math.min(1, hugArc / Math.max(1e-3, opts.length));

  const onSkull = (y: number) => {
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return skullPoint(horiz.clone().multiplyScalar(r).setY(y), R, face, clear + opts.thick * 0.5);
  };

  const out: Station[] = [];
  const exit = onSkull(endY);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let pos: THREE.Vector3;
    if (t <= hugFrac) {
      const u = hugFrac > 0 ? t / hugFrac : 1;
      pos = onSkull(THREE.MathUtils.lerp(opts.startY, endY, u));
    } else {
      // Free fall, with a little drift away from the neck.
      const f = (t - hugFrac) / Math.max(1e-3, 1 - hugFrac);
      const fall = (opts.length - hugArc) * R * f;
      // The swing clear happens fast, the drift slowly: hair leaves the head
      // in the first few centimetres and then just hangs.
      const out = (push * Math.min(1, f * 4) + (opts.sway ?? 0.10) * f) * R;
      pos = exit.clone().add(new THREE.Vector3(horiz.x * out, -fall, horiz.z * out));
    }
    const k = opts.shape ? opts.shape(t) : 1;
    out.push({
      pos,
      radiusX: opts.thick * R * k * (opts.flat ?? 1) * (1 - taper * t),
      radiusZ: opts.thick * R * k * 0.72 * (1 - taper * t),
      bone: 'Head',
      blendBone: 'Neck',
      blendWeight: Math.min(0.45, Math.max(0, t - hugFrac * 0.5) * 0.8),
      squareness: 2.5,
    });
  }
  return out;
}

/**
 * A curtain of hair down one side of the face.
 *
 * MUITAS mechas finas, não três grossas. Uma mecha com o volume certo tem 3 cm
 * de diâmetro, e três delas lado a lado leem como cabo de fone de ouvido — foi
 * exatamente o que a revisão de close apontou. O volume é o mesmo; o que muda é
 * em quantos fios ele está dividido, e é isso que separa cabelo de salsicha.
 */
function curtain(
  ctx: StyleContext,
  side: number,
  opts: { length: number; thick: number; z: number; count?: number; flat?: number },
): Station[][] {
  const n = opts.count ?? 8;
  return Array.from({ length: n }, (_, i) => {
    const u = n === 1 ? 0.5 : i / (n - 1);
    const skew = THREE.MathUtils.lerp(0.34, -0.40, u);
    // Espessura e comprimento variam por fio: uma cortina de mechas idênticas
    // volta a ler como um bloco, por mais fina que cada uma seja.
    const j = Math.sin(i * 12.9898 + side) * 0.5 + 0.5;
    return drape(ctx, {
      dir: V(side * 0.94, 0, opts.z + skew),
      startY: 0.46 - Math.abs(skew) * 0.1,
      length: opts.length * (1 - Math.abs(skew) * 0.16) * (0.82 + j * 0.36),
      thick: opts.thick * (0.78 + j * 0.44),
      // Camadas: cada fio um pouco mais afastado do crânio que o anterior, o
      // que impede que oito tubos ocupem a mesma superfície e briguem por z.
      clear: 0.030 + (i % 3) * 0.010,
      sway: 0.06,
      flat: opts.flat ?? 2.0,
    });
  });
}

/**
 * Fiapos curtos ao longo da linha do cabelo, varrendo para trás.
 *
 * Toda base termina numa curva de cobertura, e uma curva limpa em volta da
 * testa é a borda de uma touca de natação. O que quebra a borda é o cabelo
 * curto que nasce nela — poucos milímetros de fio deitados para trás, que
 * ninguém enxerga como mecha e todo mundo enxerga como cabelo.
 */
function hairlineWisps(
  ctx: StyleContext,
  opts: { y: number; thick: number; length: number; count?: number; arc?: number },
): Station[][] {
  const n = opts.count ?? 30;
  const arc = opts.arc ?? 2.5;
  const out: Station[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1) - 0.5) * arc;
    const j = Math.sin(i * 9.7331) * 0.5 + 0.5;
    const r = Math.sqrt(Math.max(0.02, 1 - opts.y * opts.y));
    const from = V(Math.sin(a) * r, opts.y + (j - 0.5) * 0.06, Math.cos(a) * r);
    out.push(lock(ctx, from, V(from.x * 0.4, 0.55, from.z * 0.4 - 0.5), {
      length: opts.length * (0.6 + j * 0.8),
      thick: opts.thick * (0.7 + j * 0.5),
      sag: 0.25,
      taper: 0.85,
      steps: 3,
      lift: 0.006 + (i % 3) * 0.008,
    }));
  }
  return out;
}

/**
 * Mechas nascendo do REDEMOINHO e descendo pela calota.
 *
 * Sem elas o topo da cabeça é a casca lisa da base, e a casca lisa é o
 * "capacete" que denuncia cabelo procedural em qualquer close: por mais bem
 * feitas que sejam a franja e a nuca, o meio continua sendo uma superfície sem
 * fio nenhum. Cada mecha sai do polo por um meridiano diferente e segue o
 * crânio, com a folga escalonada em três camadas para as pontas se recortarem
 * umas contra as outras.
 */
function crown(
  ctx: StyleContext,
  opts: { count?: number; length: number; thick: number; hugTo?: number; spread?: number },
): Station[][] {
  const n = opts.count ?? 22;
  const spread = opts.spread ?? 1.45;
  return Array.from({ length: n }, (_, i) => {
    const a = (i / (n - 1) - 0.5) * Math.PI * spread;
    const j = Math.sin(i * 5.1713) * 0.5 + 0.5;
    return drape(ctx, {
      dir: V(Math.sin(a), 0, -Math.cos(a) * 0.65 - 0.35),
      startY: 0.94,
      length: opts.length * (0.84 + j * 0.32),
      thick: opts.thick * (0.78 + j * 0.44),
      // ACIMA da espessura da base, não dentro dela. A primeira versão usava
      // 0,006 e a base do bob tem 0,030: as mechas da calota estavam todas
      // enterradas na casca que deveriam quebrar.
      clear: 0.034 + (i % 3) * 0.011,
      sway: 0.03,
      hugTo: opts.hugTo ?? 0.08,
      taper: 0.62,
      steps: 7,
    });
  });
}

/** The mass at the back of the head — usually most of the silhouette. */
function backMass(
  ctx: StyleContext,
  opts: { length: number; thick: number; width: number; count?: number; flat?: number },
): Station[][] {
  const n = opts.count ?? 14;
  return Array.from({ length: n }, (_, i) => {
    const u = n === 1 ? 0.5 : i / (n - 1);
    const x = THREE.MathUtils.lerp(-0.82, 0.82, u);
    const j = Math.sin(i * 7.3311) * 0.5 + 0.5;
    return drape(ctx, {
      dir: V(x * opts.width, 0, -1),
      startY: 0.40,
      length: opts.length * (0.88 + j * 0.24),
      thick: opts.thick * (0.8 + j * 0.4),
      clear: 0.028 + (i % 3) * 0.010,
      sway: 0.08,
      flat: opts.flat ?? 2.2,
    });
  });
}

/**
 * A gathered tail. It leaves the band already clear of the skull — a tail that
 * starts on the scalp and falls vertically spends its first 15 cm inside the
 * head — and pinches just below the tie, which is the one detail that says
 * "tied" rather than "lump".
 */
function tail(ctx: StyleContext, opts: { anchorY: number; length: number; thick: number; kink: number }): Station[] {
  return drape(ctx, {
    dir: V(0, 0, -1),
    startY: opts.anchorY,
    length: opts.length,
    thick: opts.thick,
    clear: 0.05,
    sway: 0.10,
    // Leaves the band and hangs: hugging to the jaw painted the tail flat on
    // the back of the skull.
    hugTo: 0.30,
    push: 0.55,
    steps: 10,
    taper: 0.45,
    shape: (t) => (t < 0.16 ? 0.5 : 1.15 - Math.sin(t * 2.6) * opts.kink),
  });
}

/** Two braids, with the bulge cycle that makes a tube read as plaited. */
function braids(ctx: StyleContext, opts: { length: number; thick: number }): Station[][] {
  const out: Station[][] = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const spread = (i - 1) * 0.22;
      out.push(drape(ctx, {
        dir: V(side * (0.55 + spread * 0.5), 0, -0.9 + spread * 0.3),
        startY: 0.44 - Math.abs(spread) * 0.06,
        length: opts.length * (1 - Math.abs(spread) * 0.2),
        thick: opts.thick * (i === 1 ? 1 : 0.85),
        clear: 0.026 + i * 0.008,
        sway: 0.08,
        hugTo: 0.18,
        push: 0.34,
        steps: 13,
        taper: 0.28,
        shape: (t) => 1 + Math.sin(t * 16 + i) * 0.26,
      }));
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Styles
// --------------------------------------------------------------------------

/**
 * A hairline: the height above which hair grows, HIGH across the forehead and
 * low at the nape. The first version added the forward-facing weight to the
 * height instead of to the threshold, which grew the most hair exactly where
 * there should be none — every style came out as a mask over the face.
 *
 * `front` is the threshold at the forehead, `back` at the nape; the sides
 * interpolate between them.
 *
 * **Onde nasce cabelo.** Os limiares frontais eram 0,24–0,34, e com a rampa de
 * 0,32 que este mask usa isso punha a touca cobrindo a testa INTEIRA, até a
 * altura da sobrancelha. Era a causa do "capacete", e era sistêmica: valia
 * para os nove estilos. Uma linha do cabelo de verdade fica por volta de 0,45
 * nesta esfera; quem cobre a testa, quando o estilo pede, é a FRANJA — que
 * tem ponta, vão e comprimento variável, e por isso lê como cabelo em vez de
 * casca. Estilo puxado para trás (rabo de cavalo, moicano) ganhou de brinde o
 * que faltava: testa.
 */
const hairline = (n: THREE.Vector3, front: number, side: number, back: number) => {
  // Three anchors, not two. Interpolating forehead straight to nape gave the
  // temples the NAPE's hairline, so every style grew hair over the ears and
  // down the cheek.
  const t = Math.pow(Math.abs(n.z), 1.2);
  let threshold = n.z >= 0
    ? THREE.MathUtils.lerp(side, front, t)
    : THREE.MathUtils.lerp(side, back, t);

  /**
   * A linha do cabelo NÃO é um círculo horizontal.
   *
   * Um limiar que só depende da altura recorta a touca num paralelo da esfera:
   * uma reta atravessando a testa de orelha a orelha, que é a touca de natação
   * em pessoa. Ela ficava escondida enquanto a cobertura descia até a
   * sobrancelha; ao subir a linha para onde nasce cabelo, ela apareceu.
   *
   * O que uma linha do cabelo tem, e esta não tinha: um BICO no meio, duas
   * ENTRADAS onde a testa avança sobre a têmpora, e irregularidade — nenhuma
   * é reta em lugar nenhum. Tudo isto vale só na frente (`t`), porque nuca não
   * tem entrada.
   */
  const m = Math.abs(n.x);
  const peak = 0.055 * Math.exp(-Math.pow(m / 0.20, 2));
  const recess = 0.075 * Math.exp(-Math.pow((m - 0.46) / 0.24, 2));
  const wobble = 0.016 * Math.sin(m * 15.3) + 0.010 * Math.sin(m * 31.7 + 1.1);
  threshold += (recess - peak + wobble) * t * Math.max(0, Math.sign(n.z));
  // A wide ramp on purpose: the sphere steps about 0.07 of n.y per ring here,
  // so a narrow transition lands on two quad rows and reads as stair steps.
  return smooth(threshold - 0.20, threshold + 0.12, n.y);
};

export const HAIR_STYLES: Record<string, HairStyle> = {
  // --- short ------------------------------------------------------------
  hair_buzz_01: {
    thickness: 0.012,
    base: (n) => hairline(n, 0.42, 0.06, -0.24),
  },

  hair_crop_01: {
    thickness: 0.026,
    base: (n) => hairline(n, 0.40, 0.04, -0.26),
    locks: (ctx) => [
      ...crown(ctx, { count: 20, length: 0.55, thick: 0.020, hugTo: 0.30 }),
      ...hairlineWisps(ctx, { y: 0.35, thick: 0.020, length: 0.17 }),
      ...fan(ctx, 20, { fromX: -0.54, toX: 0.54, y: 0.66, z: 0.58 },
        (u) => V((u - 0.5) * 0.5, 0.30, 1), { length: 0.26, thick: 0.030, sag: 0.9, jitter: 0.05, taper: 0.75 }),
    ],
  },

  hair_wave_01: {
    thickness: 0.034,
    base: (n) => hairline(n, 0.42, 0.04, -0.26),
    locks: (ctx) => [
      ...crown(ctx, { count: 22, length: 0.6, thick: 0.022, hugTo: 0.28 }),
      ...hairlineWisps(ctx, { y: 0.33, thick: 0.020, length: 0.18 }),
      // Swept back off the forehead: the strands leave toward -Z, so the
      // silhouette gains a crest instead of a helmet.
      ...fan(ctx, 24, { fromX: -0.60, toX: 0.60, y: 0.62, z: 0.62 },
        (u) => V((u - 0.5) * 0.7, 0.55, -1), { length: 0.62, thick: 0.032, sag: 0.35, wave: 0.02, jitter: 0.06, taper: 0.72 }),
      ...fan(ctx, 14, { fromX: -0.74, toX: 0.74, y: 0.18, z: 0.10 },
        (u) => V(Math.sign(u - 0.5) * 0.6, 0.1, -1), { length: 0.34, thick: 0.028, sag: 0.7, jitter: 0.03 }),
    ],
  },

  hair_mohawk_01: {
    thickness: 0.008,
    base: (n) => hairline(n, 0.40, 0.10, -0.20),
    locks: (ctx) => {
      // Rooted along the midline from brow to crown, tall in the middle. The
      // first pass rooted all nine at one point and offset them afterwards,
      // which produced antennae floating clear of the skull.
      const out: Station[][] = [];
      const n = 19;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const zDir = THREE.MathUtils.lerp(0.85, -0.85, u);
        const height = 0.16 + Math.sin(u * Math.PI) * 0.30;
        out.push(lock(ctx, V(0, Math.sqrt(Math.max(0.04, 1 - zDir * zDir)), zDir),
          V(0, 1, zDir * 0.25), { length: height, thick: 0.042, sag: 0.06, taper: 0.55, steps: 3 }));
      }
      return out;
    },
  },

  hair_afro_01: {
    thickness: 0.080,
    base: (n) => hairline(n, 0.38, 0.02, -0.28) * (0.88 + 0.12 * Math.sin(n.x * 21) * Math.sin(n.z * 21)),
    locks: (ctx) => {
      // Clumps rather than one smooth ball: an afro reads by its broken edge.
      const out: Station[][] = [];
      for (let i = 0; i < 54; i++) {
        const a = i * 2.39996;
        const y = 0.85 - (i / 54) * 1.35;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        out.push(lock(ctx, V(Math.cos(a) * r, y, Math.sin(a) * r), V(Math.cos(a) * r, y * 0.6 + 0.4, Math.sin(a) * r),
          { length: 0.055, thick: 0.070, sag: 0.05, taper: 0.05, steps: 2 }));
      }
      return out;
    },
  },

  // --- medium and long ---------------------------------------------------
  hair_bob_01: {
    thickness: 0.030,
    base: (n) => hairline(n, 0.40, -0.05, -0.40),
    locks: (ctx) => [
      ...crown(ctx, { count: 24, length: 0.95, thick: 0.024 }),
      ...curtain(ctx, -1, { length: 1.75, thick: 0.046, z: -0.10, count: 9 }),
      ...curtain(ctx, 1, { length: 1.75, thick: 0.046, z: -0.10, count: 9 }),
      ...backMass(ctx, { length: 1.85, thick: 0.038, width: 0.5, count: 15 }),
      // DUAS camadas de franja, deslocadas meio passo uma da outra. Uma fileira
      // só, por mais fina que seja, termina toda na mesma altura e lê como um
      // pente — dentes paralelos com testa aparecendo entre eles. O que cobre
      // o vão é a segunda camada, e o que quebra o pente é a variação de
      // comprimento entre fios vizinhos.
      // A varredura desce MAIS do que avança. Com a componente para a frente
      // maior que a de baixo, cada mecha sai da testa em vez de deitar sobre
      // ela, e a franja fica pairando com pele aparecendo entre os fios.
      ...fan(ctx, 15, { fromX: -0.52, toX: 0.52, y: 0.60, z: 0.66 },
        (u) => V((u - 0.5) * 0.9, -0.95, 0.42),
        { length: 0.46, thick: 0.036, flat: 2.6, sag: 0.5, jitter: 0.16, wave: 0.006, taper: 0.86 }),
      ...fan(ctx, 12, { fromX: -0.47, toX: 0.47, y: 0.645, z: 0.62 },
        (u) => V((u - 0.5) * 1.1, -0.88, 0.5),
        { length: 0.40, thick: 0.032, flat: 2.3, sag: 0.55, jitter: 0.20, wave: 0.008, taper: 0.88, lift: 0.022 }),
    ],
  },

  hair_long_01: {
    thickness: 0.032,
    base: (n) => hairline(n, 0.38, -0.06, -0.45),
    locks: (ctx) => [
      ...crown(ctx, { count: 26, length: 1.0, thick: 0.024 }),
      ...curtain(ctx, -1, { length: 3.3, thick: 0.048, z: -0.05, count: 10 }),
      ...curtain(ctx, 1, { length: 3.3, thick: 0.048, z: -0.05, count: 10 }),
      ...backMass(ctx, { length: 3.5, thick: 0.042, width: 0.7, count: 16 }),
      ...fan(ctx, 24, { fromX: -0.48, toX: 0.48, y: 0.62, z: 0.64 },
        (u) => V((u - 0.5) * 1.2, -0.9, 0.42),
        { length: 0.46, thick: 0.028, sag: 0.55, jitter: 0.11, wave: 0.008, taper: 0.8 }),
      ...fan(ctx, 18, { fromX: -0.42, toX: 0.42, y: 0.66, z: 0.60 },
        (u) => V((u - 0.5) * 1.4, -0.8, 0.5), { length: 0.36, thick: 0.024, sag: 0.6, jitter: 0.14, taper: 0.82, lift: 0.016 }),
    ],
  },

  hair_ponytail_01: {
    thickness: 0.024,
    base: (n) => hairline(n, 0.40, 0.02, -0.32),
    locks: (ctx) => [
      // O rabo é um FEIXE amarrado, então continua grosso — mas ganha três
      // fios soltos por cima, porque um tubo liso é o que faz um rabo de
      // cavalo parecer plástico.
      // Puxado para trás: as mechas da calota vão quase todas para a nuca, que
      // é onde o rabo é amarrado.
      ...crown(ctx, { count: 22, length: 0.62, thick: 0.021, hugTo: 0.34, spread: 1.1 }),
      // Cinco fios em vez de três, e o mais grosso caiu de 0,115 para 0,072:
      // com um tubo daquele calibre o rabo lia como CORDA — uma tromba lisa
      // saindo da nuca. O volume total é o mesmo; o que muda é em quantas
      // mechas ele está dividido, que é a mesma lição da cortina.
      tail(ctx, { anchorY: 0.60, length: 2.9, thick: 0.072, kink: 0.10 }),
      tail(ctx, { anchorY: 0.585, length: 2.75, thick: 0.052, kink: 0.16 }),
      tail(ctx, { anchorY: 0.615, length: 2.6, thick: 0.046, kink: 0.05 }),
      tail(ctx, { anchorY: 0.575, length: 2.45, thick: 0.040, kink: 0.22 }),
      tail(ctx, { anchorY: 0.625, length: 3.05, thick: 0.036, kink: 0.13 }),
      ...fan(ctx, 22, { fromX: -0.62, toX: 0.62, y: 0.58, z: 0.42 },
        (u) => V((u - 0.5) * 1.1, 0.16, -0.92), { length: 0.42, thick: 0.026, sag: 0.42, jitter: 0.06, taper: 0.78 }),
      // Fiapos NA linha do cabelo. Sem eles a base termina numa curva limpa
      // cortada a faca em volta da testa — a borda dura é o que faz um
      // penteado preso ler como touca, e nenhuma quantidade de mecha no topo
      // conserta uma borda.
      ...hairlineWisps(ctx, { y: 0.33, thick: 0.020, length: 0.20 }),
    ],
  },

  hair_braids_01: {
    thickness: 0.028,
    base: (n) => hairline(n, 0.40, 0.02, -0.34) * (0.9 + 0.1 * Math.sin(Math.atan2(n.x, n.z) * 9)),
    locks: (ctx) => [
      ...crown(ctx, { count: 20, length: 0.7, thick: 0.020, hugTo: 0.30, spread: 1.2 }),
      ...hairlineWisps(ctx, { y: 0.33, thick: 0.019, length: 0.18 }),
      ...braids(ctx, { length: 3.0, thick: 0.052 }),
      ...fan(ctx, 16, { fromX: -0.58, toX: 0.58, y: 0.60, z: 0.48 },
        (u) => V((u - 0.5) * 1.0, 0.14, -0.9), { length: 0.34, thick: 0.024, sag: 0.4, jitter: 0.03 }),
    ],
  },
};

// --------------------------------------------------------------------------
// Build
// --------------------------------------------------------------------------

/** The scalp cap, laid on the sculpted skull rather than on a bare sphere. */
function scalp(style: HairStyle, ctx: StyleContext): THREE.BufferGeometry | null {
  const { R, face } = ctx;
  const geo = new THREE.SphereGeometry(1, 56, 40);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = new THREE.Vector3();
  const keep: boolean[] = [];
  let any = false;

  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    const cover = style.base(n);
    const on = cover > 0.02;
    keep.push(on);
    any = any || on;

    // The cap does not END at the hairline — it DIVES under the skin there.
    // Cutting it at a threshold puts the boundary on the sphere's quad grid,
    // and since the mask ramp spans barely two rings the hairline comes out as
    // visible stair steps. Below 35% coverage the cap is buried; above 85% it
    // floats clear of the skin it would otherwise z-fight; in between it
    // emerges, so what a player sees is hair growing out of a scalp.
    const buried = 1 - smooth(0.35, 0.85, cover);

    /**
     * O CAPACETE morava aqui.
     *
     * A touca subia do crânio por um valor constante (a espessura do estilo),
     * o que produz uma esfera concêntrica com a cabeça: lisa, de espessura
     * uniforme, com um rebordo duro na linha do cabelo. Nenhuma quantidade de
     * mecha por cima desmente essa superfície — ela é grande, é o fundo de
     * tudo, e é ela que o olho lê primeiro.
     *
     * Duas coisas consertam, e as duas são de VOLUME, não de fio:
     *
     * 1. **O cabelo se acumula.** Ele é espesso na coroa e na nuca, e fino na
     *    linha do cabelo e na têmpora — onde é quase pele. Um perfil de
     *    empilhamento dá à cabeça uma silhueta de cabeleira em vez de uma
     *    cabeça um número maior.
     * 2. **A superfície ondula.** Cabelo real se agrupa em massas de vários
     *    centímetros; uma casca perfeitamente lisa é plástico. Duas ondas de
     *    baixa frequência bastam — e por serem função da DIREÇÃO, não custam
     *    um triângulo a mais, o que importa porque a touca já é a maior malha
     *    da cabeça.
     *
     * As duas escalam com a espessura do estilo: um raspado (0,012) fica
     * praticamente rente, como deve.
     */
    const pile = 0.45 + 0.85 * smooth(-0.20, 0.95, n.y)
      + 0.45 * smooth(0.10, -0.95, n.z) * smooth(-0.55, 0.35, n.y);
    const azim = Math.atan2(n.x, n.z);
    const ripple = Math.sin(azim * 4.0 + n.y * 3.4) * 0.55
      + Math.sin(azim * 7.0 - n.y * 5.1) * 0.30
      + Math.sin(n.y * 9.0 + azim * 2.0) * 0.22;

    const body = cover * style.thickness * (pile + ripple * 0.34);
    const lift = body + 0.006 - 0.026 * buried;
    const p = skullPoint(n, R, face, lift);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  if (!any) return null;

  const idx = geo.getIndex()!;
  const kept: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (keep[a] || keep[b] || keep[c]) kept.push(a, b, c);
  }
  geo.setIndex(kept);
  geo.computeVertexNormals();

  const count = pos.count;
  const si = new Uint16Array(count * 4);
  const sw = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { si[i * 4] = BONE_INDEX.Head; sw[i * 4] = 1; }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  geo.setAttribute('uv1', geo.attributes.uv.clone());
  return geo;
}

export function buildHair(
  rig: BuiltRig,
  face: FaceShape,
  styleId: string,
  colorIndex: number,
): THREE.SkinnedMesh | null {
  const style = HAIR_STYLES[styleId];
  if (!style) return null;

  const R = headRadius(rig, face);
  const ctx: StyleContext = { R, face };
  const pieces: THREE.BufferGeometry[] = [];

  const cap = scalp(style, ctx);
  if (cap) pieces.push(cap);

  const locks = style.locks?.(ctx) ?? [];
  if (locks.length) {
    pieces.push(assemble(locks.map((st) => loft(st, {
      segments: 8, capStart: true, capEnd: true, capRound: 0.8, subdivisions: 2,
    }))));
  }
  if (!pieces.length) return null;

  const geo = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces);
  geo.computeVertexNormals();
  const c = headCentre(rig, face);
  geo.translate(0, rig.restWorld.Head.y + c.y, c.z);

  const mesh = new THREE.SkinnedMesh(geo, makeHairMaterial(colorIndex));
  mesh.name = 'hair';
  mesh.castShadow = true;
  return mesh;
}
