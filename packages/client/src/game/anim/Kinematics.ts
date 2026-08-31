import * as THREE from 'three';
import { BONE_NAMES, REST, type BoneName, type BuiltRig } from '../avatar/Skeleton.js';
import type { SampledPose } from './Pose.js';
import { restQuat } from './Pose.js';

/**
 * Side-effect-free forward kinematics over a rig's rest offsets. Used at clip
 * compile time to answer the two questions a hand-authored walk cannot answer
 * on its own: where is the sole, and how far does the body actually travel in
 * one cycle. Deliberately does NOT touch the live bones — compiling a clip
 * must never disturb an avatar that is already animating.
 */
export class ForwardKinematics {
  private readonly order: BoneName[] = BONE_NAMES.slice();
  private readonly parentOf: Array<number> = [];
  private readonly offset: THREE.Vector3[] = [];
  private readonly world: THREE.Matrix4[] = [];
  private readonly index = new Map<BoneName, number>();
  private readonly local = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(rig: BuiltRig) {
    this.order.forEach((name, i) => this.index.set(name, i));
    for (const name of this.order) {
      const parent = REST[name].parent;
      this.parentOf.push(parent ? this.index.get(parent)! : -1);
      this.offset.push(rig.bones[name].position.clone());
      this.world.push(new THREE.Matrix4());
    }
  }

  /** Solves every bone's matrix for one sample of a compiled clip. */
  solve(sample: number, poses: SampledPose, hipsExtra: THREE.Vector3): this {
    for (let i = 0; i < this.order.length; i++) {
      const name = this.order[i];
      const track = poses.quats.get(name);
      if (track) {
        this.q.set(track[sample * 4], track[sample * 4 + 1], track[sample * 4 + 2], track[sample * 4 + 3]);
      } else {
        this.q.copy(restQuat(name));
      }
      const pos = this.offset[i];
      if (i === 0) {
        this.local.compose(
          new THREE.Vector3(pos.x + hipsExtra.x, pos.y + hipsExtra.y, pos.z + hipsExtra.z),
          this.q, this.one,
        );
      } else {
        this.local.compose(pos, this.q, this.one);
      }
      const p = this.parentOf[i];
      if (p < 0) this.world[i].copy(this.local);
      else this.world[i].multiplyMatrices(this.world[p], this.local);
    }
    return this;
  }

  position(name: BoneName, out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(this.world[this.index.get(name)!]);
  }
}

/** Heights of the contact points in the rest pose; the ground is y = 0 there. */
export interface SoleReference {
  ankle: number;
  toe: number;
}

export function soleReference(rig: BuiltRig): SoleReference {
  return { ankle: rig.restWorld.LeftFoot.y, toe: rig.restWorld.LeftToeBase.y };
}

const FEET: Array<{ foot: BoneName; toe: BoneName }> = [
  { foot: 'LeftFoot', toe: 'LeftToeBase' },
  { foot: 'RightFoot', toe: 'RightToeBase' },
];

export interface ContactSample {
  /** Signed distance of the lowest sole to the floor. 0 = planted. */
  clearance: number;
  /** 0 = left foot lower, 1 = right foot lower. */
  planted: 0 | 1;
  /** Forward (+Z) coordinate of the planted foot in character space. */
  plantedZ: number;
}

export function sampleContacts(
  fk: ForwardKinematics, poses: SampledPose, sole: SoleReference, hipsExtra: THREE.Vector3[],
): ContactSample[] {
  const v = new THREE.Vector3();
  const out: ContactSample[] = [];
  for (let s = 0; s < poses.times.length; s++) {
    fk.solve(s, poses, hipsExtra[s]);
    let best = Infinity;
    let planted: 0 | 1 = 0;
    let plantedZ = 0;
    for (let f = 0; f < FEET.length; f++) {
      fk.position(FEET[f].foot, v);
      const heel = v.y - sole.ankle;
      const heelZ = v.z;
      fk.position(FEET[f].toe, v);
      const toe = v.y - sole.toe;
      const low = Math.min(heel, toe);
      if (low < best) {
        best = low;
        planted = f as 0 | 1;
        // The heel carries the weight through most of stance; measure slide there.
        plantedZ = heel <= toe ? heelZ : v.z;
      }
    }
    out.push({ clearance: best, planted, plantedZ });
  }
  return out;
}

export interface LocomotionMeasurement {
  /** Metres the body advances in one full cycle at playback rate 1. */
  cycleDistance: number;
  /** Metres/second the clip implies at rate 1. */
  baseSpeed: number;
  /** Worst residual travel of a planted foot in world space. Under 1 cm is good. */
  maxSlide: number;
  /** Lowest sole clearance after grounding. Negative means a foot is underground. */
  minClearance: number;
  maxClearance: number;
}

/**
 * Derives how far the character travels per cycle from the geometry of the
 * clip itself, by integrating how far the planted foot slides backwards
 * underneath the hips. Hard-coding a stride length is what produces foot
 * sliding: the number has to come from the pose, not from a guess.
 */
export function measureLocomotion(
  contacts: ContactSample[], times: number[], duration: number,
): LocomotionMeasurement {
  let distance = 0;
  const n = contacts.length - 1; // last sample duplicates the first for looping
  for (let i = 0; i < n; i++) {
    const a = contacts[i];
    const b = contacts[(i + 1) % n];
    if (a.planted === b.planted) distance += a.plantedZ - b.plantedZ;
  }
  const baseSpeed = duration > 0 ? distance / duration : 0;

  let maxSlide = 0;
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    const same = i < n && contacts[i].planted === contacts[runStart].planted;
    if (!same) {
      let lo = Infinity, hi = -Infinity;
      for (let j = runStart; j < i; j++) {
        // World position of the planted foot if the body advances at baseSpeed.
        const w = contacts[j].plantedZ + baseSpeed * times[j];
        lo = Math.min(lo, w); hi = Math.max(hi, w);
      }
      if (hi - lo > maxSlide) maxSlide = hi - lo;
      runStart = i;
    }
  }

  let minClearance = Infinity, maxClearance = -Infinity;
  for (const c of contacts) {
    minClearance = Math.min(minClearance, c.clearance);
    maxClearance = Math.max(maxClearance, c.clearance);
  }
  return { cycleDistance: distance, baseSpeed, maxSlide, minClearance, maxClearance };
}
