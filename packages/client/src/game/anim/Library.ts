import type { AnimState } from '@streampolis/shared';
import type { BuiltRig } from '../avatar/Skeleton.js';
import { compileClip, type CompiledClip } from './Compile.js';
import { CLIP_SPECS } from './Clips.js';

/**
 * Compiled clips, cached per rig shape.
 *
 * Rotation tracks do not care how tall an avatar is, but the hip track does:
 * hip offsets are authored as a fraction of hip height and the ground lock has
 * to know where this rig's soles are. So clips are compiled once per
 * (hip height, sole height) bucket and shared by every avatar in it — a plaza
 * of forty visitors with four body presets compiles four sets, not forty.
 */

export type ClipSet = Record<AnimState, CompiledClip>;

const cache = new Map<string, ClipSet>();

function bucketKey(rig: BuiltRig): string {
  // Two decimals is a centimetre: below that the ground lock is identical.
  return `${rig.restWorld.Hips.y.toFixed(2)}|${rig.restWorld.LeftFoot.y.toFixed(2)}|${rig.restWorld.LeftToeBase.y.toFixed(2)}`;
}

export function clipsForRig(rig: BuiltRig): ClipSet {
  const key = bucketKey(rig);
  const hit = cache.get(key);
  if (hit) return hit;

  const set = {} as ClipSet;
  for (const [state, spec] of Object.entries(CLIP_SPECS) as Array<[AnimState, typeof CLIP_SPECS[AnimState]]>) {
    set[state] = compileClip(spec, rig);
  }
  cache.set(key, set);
  return set;
}

/**
 * What the compiler measured, for the review loop: a walk whose planted foot
 * slides more than a centimetre is a walk the eye reads as skating, and the
 * number is the only way to see it without watching frame by frame.
 */
export interface ClipReport {
  name: string;
  duration: number;
  samples: number;
  baseSpeed: number;
  maxSlide: number;
  minClearance: number;
}

export function clipReport(rig: BuiltRig): ClipReport[] {
  const set = clipsForRig(rig);
  return Object.values(set).map((c) => ({
    name: c.clip.name,
    duration: c.spec.duration,
    samples: c.samples,
    baseSpeed: round(c.measure.baseSpeed),
    maxSlide: round(c.measure.maxSlide),
    minClearance: round(c.measure.minClearance),
  }));
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Frees every cached set. Only for teardown in tests and the avatar lab. */
export function clearClipCache(): void {
  cache.clear();
}
