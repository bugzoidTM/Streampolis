import * as THREE from 'three';
import type { BoneName, BuiltRig } from '../avatar/Skeleton.js';
import { samplePoses, type ClipSpec, type SampledPose } from './Pose.js';
import {
  ForwardKinematics, measureLocomotion, sampleContacts, soleReference,
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

  const measure = measureLocomotion(contacts, poses.times, spec.duration);

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
