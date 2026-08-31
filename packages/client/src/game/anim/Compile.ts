import * as THREE from 'three';
import type { BoneName, BuiltRig } from '../avatar/Skeleton.js';
import { samplePoses, type ClipSpec, type SampledPose } from './Pose.js';
import {
  ForwardKinematics, measureLocomotion, sampleContacts, soleReference, stanceRuns, trimStance,
  type LocomotionMeasurement,
} from './Kinematics.js';

export interface CompiledClip {
  clip: THREE.AnimationClip;
  spec: ClipSpec;
  /** Only meaningful for locomotion clips, but measured for all of them. */
  measure: LocomotionMeasurement;
  /** Sample count actually baked, for the budget report. */
  samples: number;
}

/**
 * Turns a ClipSpec into a THREE.AnimationClip for one specific rig.
 *
 * The rig matters because of the hip track: hip offsets are authored as a
 * fraction of hip height and the ground lock has to know where this rig's
 * soles are. Rotation tracks are rig-independent, so clips are cached per
 * height bucket rather than per avatar (see ClipLibrary).
 */
export function compileClip(spec: ClipSpec, rig: BuiltRig): CompiledClip {
  const hipHeight = rig.restWorld.Hips.y;
  const poses: SampledPose = samplePoses(spec, hipHeight);
  const fk = new ForwardKinematics(rig);
  const sole = soleReference(rig);

  let contacts = sampleContacts(fk, poses, sole, poses.hips);

  const mode = spec.ground ?? 'off';
  if (mode !== 'off') {
    // A hip translation moves every bone by the same vector, so one pass is
    // exact: shifting the hips by -clearance puts the lowest sole on y = 0.
    for (let s = 0; s < contacts.length; s++) {
      const dy = mode === 'lock' ? -contacts[s].clearance : Math.max(0, -contacts[s].clearance);
      poses.hips[s].y += dy;
      contacts[s] = { ...contacts[s], clearance: contacts[s].clearance + dy };
    }
    if (spec.loop) {
      // The wrap sample must match sample 0 exactly or the loop pops.
      poses.hips[poses.hips.length - 1].copy(poses.hips[0]);
    }
  }

  let measure = measureLocomotion(contacts, poses.times, spec.duration);

  if (spec.locomotion) {
    // Foot lock.
    //
    // The body advances at a constant rate, but a hand-authored cycle eases
    // between its keys, so the planted heel drifts under the body instead of
    // staying put — the single largest source of foot sliding in a four-key
    // walk. The drift is removed from the HIP track, which translates the whole
    // body and leaves every pose exactly as authored.
    //
    // The correction is smoothed and mean-free on purpose. Smoothed, because a
    // per-stance step function would pop the hips the moment the weight
    // changes feet; mean-free, because the clip must not walk away from its
    // own origin. What survives is a small forward/back pulse across the
    // cycle, which is what a real walk does: fastest at push-off, slowest at
    // heel strike.
    const advance = measure.baseSpeed;
    const n = contacts.length - 1;
    const correction = new Array<number | null>(n).fill(null);
    for (const run of stanceRuns(contacts)) {
      // Only the samples where this foot really carries the weight; the ones
      // at either end are double support, and a correction anchored on them
      // lurches the hips by the width of a step.
      const [from, to] = trimStance(run[0], run[1]);
      let anchor = 0;
      for (let i = from; i < to; i++) anchor += contacts[i].plantedZ + advance * poses.times[i];
      anchor /= to - from;
      for (let i = from; i < to; i++) {
        correction[i] = anchor - (contacts[i].plantedZ + advance * poses.times[i]);
      }
    }
    const c = fillGaps(correction);
    smoothCircular(c, 1);
    const mean = c.reduce((a, b) => a + b, 0) / Math.max(1, c.length);
    for (let i = 0; i < n; i++) poses.hips[i].z += c[i] - mean;
    // The wrap sample must equal sample 0 or the loop pops.
    if (spec.loop) poses.hips[poses.hips.length - 1].z = poses.hips[0].z;

    contacts = sampleContacts(fk, poses, sole, poses.hips);
    measure = measureLocomotion(contacts, poses.times, spec.duration);
  } else {
    // Nothing to advance: a gesture that reports a stride would drive the
    // locomotion blend with a speed the body never has.
    measure = { ...measure, cycleDistance: 0, baseSpeed: 0 };
  }

  const times = new Float32Array(poses.times);
  const tracks: THREE.KeyframeTrack[] = [];
  for (const [bone, values] of poses.quats) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone as BoneName}.quaternion`, times, values));
  }

  const movesHips = poses.hips.some((h) => h.lengthSq() > 1e-10);
  if (movesHips) {
    const rest = rig.bones.Hips.position;
    const v = new Float32Array(poses.hips.length * 3);
    for (let s = 0; s < poses.hips.length; s++) {
      v[s * 3] = rest.x + poses.hips[s].x;
      v[s * 3 + 1] = rest.y + poses.hips[s].y;
      v[s * 3 + 2] = rest.z + poses.hips[s].z;
    }
    tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times, v));
  }

  const clip = new THREE.AnimationClip(spec.name, spec.duration, tracks);
  return { clip, spec, measure, samples: poses.times.length };
}

/** Fills the airborne gaps by interpolating the correction around the cycle. */
function fillGaps(values: Array<number | null>): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(0);
  const known = values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) return out;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v !== null) { out[i] = v; continue; }
    // Nearest known sample on either side, wrapping: the cycle is a circle.
    let back = 0;
    while (values[(i - back + n) % n] === null && back < n) back++;
    let fwd = 0;
    while (values[(i + fwd) % n] === null && fwd < n) fwd++;
    const a = values[(i - back + n) % n] ?? 0;
    const b = values[(i + fwd) % n] ?? 0;
    const total = back + fwd;
    out[i] = total > 0 ? a + ((b - a) * back) / total : a;
  }
  return out;
}

/** Binomial smoothing that treats the sample list as a loop. */
function smoothCircular(values: number[], passes: number): void {
  const n = values.length;
  for (let p = 0; p < passes; p++) {
    const copy = values.slice();
    for (let i = 0; i < n; i++) {
      values[i] = 0.25 * copy[(i - 1 + n) % n] + 0.5 * copy[i] + 0.25 * copy[(i + 1) % n];
    }
  }
}

/**
 * Additive layers are subtracted against their own first frame, so a clip
 * authored to start at rest becomes a pure delta that can ride on top of any
 * base state (SPECs §14 asks only for a state machine; the additive layer is
 * what stops the result from looking like a mannequin).
 */
export function compileAdditive(spec: ClipSpec, rig: BuiltRig): CompiledClip {
  const compiled = compileClip(spec, rig);
  THREE.AnimationUtils.makeClipAdditive(compiled.clip);
  return compiled;
}
