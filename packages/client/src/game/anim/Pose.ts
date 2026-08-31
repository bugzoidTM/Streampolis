import * as THREE from 'three';
import { REST_ROTATION, type BoneName } from '../avatar/Skeleton.js';

/**
 * Authoring vocabulary for procedural animation. There is no animation GLB in
 * this project (SPECs §44 gives 20 MB for the whole first play), so every clip
 * is written as data here and compiled into a THREE.AnimationClip.
 *
 * Angles are DEGREES and are DELTAS FROM THE REST POSE, never absolutes. That
 * matters: the rest pose is a relaxed A-pose with ~7 degrees of arm splay
 * (Skeleton.REST_ROTATION), and it is still being tuned by the avatar owner.
 * Authoring deltas means an empty pose is always "standing at rest" and a
 * change to the rest splay does not silently break every clip.
 *
 * Sign conventions for a limb chain (bones point down -Y in rest):
 *   +X  swings the limb BACKWARD  (-X swings it forward)
 *   +Y  twists the limb
 *   +Z  swings the limb toward +X, i.e. OUTWARD on the left, INWARD on the right
 * For the spine/neck/head (which point up +Y) the same +X rotation tips them
 * FORWARD instead, because the bone points the other way:
 *   +X  leans forward, +Y turns toward the character's left, +Z leans right.
 * The character faces +Z (the toe offsets point that way in REST).
 */
export type Deg3 = readonly [number, number, number];

export type Pose = Partial<Record<BoneName, Deg3>>;

export type EaseName =
  | 'linear' | 'sine' | 'in' | 'out' | 'inOut' | 'snap' | 'hold' | 'wind' | 'over';

/** `u` is 0..1 along the segment. */
export const EASES: Record<EaseName, (u: number) => number> = {
  linear: (u) => u,
  /** Ease in and out — the default, because nothing in a body starts abruptly. */
  sine: (u) => 0.5 - 0.5 * Math.cos(Math.PI * u),
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  inOut: (u) => u * u * (3 - 2 * u),
  /** Almost all of the motion in the first third: whip, snap, impact. */
  snap: (u) => 1 - Math.pow(1 - u, 4),
  /** Step: hold the source pose, then pop. Used for a freeze beat. */
  hold: (u) => (u < 1 ? 0 : 1),
  /** Anticipation: pulls back before going. */
  wind: (u) => u * u * (2.70158 * u - 1.70158),
  /** Overshoot and settle. */
  over: (u) => { const c = 1.70158; const p = u - 1; return 1 + p * p * ((c + 1) * p + c); },
};

/** Shallow-merges poses left to right; later entries win. */
export function pose(...parts: Array<Pose | undefined>): Pose {
  const out: Pose = {};
  for (const p of parts) if (p) Object.assign(out, p);
  return out;
}

const OPPOSITE = (name: BoneName): BoneName => {
  if (name.startsWith('Left')) return ('Right' + name.slice(4)) as BoneName;
  if (name.startsWith('Right')) return ('Left' + name.slice(5)) as BoneName;
  return name;
};

/**
 * Mirrors a pose across the body's sagittal plane. A walk cycle is the same
 * pose half a period apart, so authoring one half and mirroring it is the only
 * way to guarantee the two sides actually match.
 */
export function mirror(p: Pose): Pose {
  const out: Pose = {};
  for (const [k, v] of Object.entries(p) as Array<[BoneName, Deg3]>) {
    // Reflecting through X negates every rotation component whose axis lies in
    // the mirror plane; only the X (forward/back swing) component survives.
    out[OPPOSITE(k)] = [v[0], -v[1], -v[2]];
  }
  return out;
}

/** Scales a pose toward rest. `k = 0` is rest, `k = 1` is the pose itself. */
export function scalePose(p: Pose, k: number): Pose {
  const out: Pose = {};
  for (const [key, v] of Object.entries(p) as Array<[BoneName, Deg3]>) {
    out[key] = [v[0] * k, v[1] * k, v[2] * k];
  }
  return out;
}

const DEG = THREE.MathUtils.DEG2RAD;
const scratchEuler = new THREE.Euler();

const REST_Q: Partial<Record<BoneName, THREE.Quaternion>> = (() => {
  const m: Partial<Record<BoneName, THREE.Quaternion>> = {};
  for (const [name, rot] of Object.entries(REST_ROTATION) as Array<[BoneName, Deg3]>) {
    m[name] = new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'XYZ'));
  }
  return m;
})();

/** Rest-pose local rotation of a bone, or identity. */
export function restQuat(bone: BoneName): THREE.Quaternion {
  return REST_Q[bone] ?? IDENTITY;
}
const IDENTITY = new THREE.Quaternion();

/**
 * Local bone rotation for a pose entry: `rest * delta`. Composing in that
 * order means the delta is expressed in the bone's own rest frame, which is
 * what an animator means by "swing the arm forward 40 degrees".
 */
export function poseQuat(bone: BoneName, deg: Deg3 | undefined, out: THREE.Quaternion): THREE.Quaternion {
  if (!deg) return out.copy(restQuat(bone));
  scratchEuler.set(deg[0] * DEG, deg[1] * DEG, deg[2] * DEG, 'XYZ');
  out.setFromEuler(scratchEuler);
  return out.premultiply(restQuat(bone));
}

/** Hip translation, in units of the rig's hip height, so it survives rescaling. */
export interface HipsKey {
  time: number;
  /** [lateral, vertical, forward] as a fraction of hip height. */
  offset: Deg3;
  ease?: EaseName;
}

export interface Keyframe {
  time: number;
  pose: Pose;
  /** Easing of the segment that LEAVES this key. Defaults to `sine`. */
  ease?: EaseName;
}

export type GroundMode =
  /** Hips ride up and down so the lowest sole stays exactly on y = 0. */
  | 'lock'
  /** Hips only ever rise: keeps a running flight phase off the floor. */
  | 'plant'
  | 'off';

export interface ClipSpec {
  name: string;
  duration: number;
  keys: Keyframe[];
  /** Appends a wrap key equal to key 0 at `duration`, so the loop is seamless. */
  loop?: boolean;
  hips?: HipsKey[];
  ground?: GroundMode;
  /** Samples generated per eased segment. More = smoother arc, bigger clip. */
  steps?: number;
}

/** Samples of a compiled clip, before it becomes a THREE.AnimationClip. */
export interface SampledPose {
  times: number[];
  /** Local quaternion per posed bone, flat [x,y,z,w] per sample. */
  quats: Map<BoneName, Float32Array>;
  /** Authored hip offset per sample, already multiplied into metres. */
  hips: THREE.Vector3[];
}

function segmentIndex(keys: Keyframe[], t: number): number {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].time <= t) i++;
  return i;
}

/**
 * Resamples the keyframes into a uniform time list. Three.js interpolates
 * quaternion tracks linearly (slerp), so easing has to be baked in as extra
 * samples — there is no per-key ease in the format.
 */
export function samplePoses(spec: ClipSpec, hipHeight: number): SampledPose {
  const keys = spec.keys.slice().sort((a, b) => a.time - b.time);
  if (spec.loop) {
    const last = keys[keys.length - 1];
    if (last.time < spec.duration - 1e-6) {
      keys.push({ time: spec.duration, pose: keys[0].pose, ease: 'linear' });
    }
  }

  const steps = spec.steps ?? 5;
  const times: number[] = [];
  const us: Array<{ seg: number; u: number }> = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    const ease = EASES[a.ease ?? 'sine'];
    const n = (a.ease ?? 'sine') === 'linear' ? 1 : steps;
    for (let j = 0; j < n; j++) {
      const raw = j / n;
      times.push(a.time + (b.time - a.time) * raw);
      us.push({ seg: i, u: ease(raw) });
    }
  }
  const last = keys[keys.length - 1];
  times.push(last.time);
  us.push({ seg: keys.length - 2, u: 1 });

  const posed = new Set<BoneName>();
  for (const k of keys) for (const b of Object.keys(k.pose) as BoneName[]) posed.add(b);

  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const quats = new Map<BoneName, Float32Array>();
  for (const bone of posed) {
    const arr = new Float32Array(times.length * 4);
    for (let s = 0; s < times.length; s++) {
      const { seg, u } = us[s];
      poseQuat(bone, keys[seg].pose[bone], qa);
      poseQuat(bone, keys[seg + 1].pose[bone], qb);
      qa.slerp(qb, u);
      arr[s * 4] = qa.x; arr[s * 4 + 1] = qa.y; arr[s * 4 + 2] = qa.z; arr[s * 4 + 3] = qa.w;
    }
    quats.set(bone, arr);
  }

  const hips = times.map(() => new THREE.Vector3());
  if (spec.hips && spec.hips.length) {
    const hk = spec.hips.slice().sort((a, b) => a.time - b.time);
    if (spec.loop && hk[hk.length - 1].time < spec.duration - 1e-6) {
      hk.push({ time: spec.duration, offset: hk[0].offset, ease: 'linear' });
    }
    for (let s = 0; s < times.length; s++) {
      const t = times[s];
      const i = segmentIndex(hk as unknown as Keyframe[], t);
      const a = hk[i], b = hk[Math.min(i + 1, hk.length - 1)];
      const span = b.time - a.time;
      const raw = span > 1e-6 ? THREE.MathUtils.clamp((t - a.time) / span, 0, 1) : 0;
      const u = EASES[a.ease ?? 'sine'](raw);
      hips[s].set(
        THREE.MathUtils.lerp(a.offset[0], b.offset[0], u) * hipHeight,
        THREE.MathUtils.lerp(a.offset[1], b.offset[1], u) * hipHeight,
        THREE.MathUtils.lerp(a.offset[2], b.offset[2], u) * hipHeight,
      );
    }
  }

  return { times, quats, hips };
}
