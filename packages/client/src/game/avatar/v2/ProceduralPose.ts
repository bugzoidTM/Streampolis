import * as THREE from 'three';
import type { AnimState } from '@streampolis/shared';
import type { ProceduralFrame } from '../AvatarLike.js';
import { FootIK } from './FootIK.js';
import { HeadLook } from './HeadLook.js';

/** A reversible post-mixer layer. No bone is inserted, rebound, or reordered. */
export class ProceduralPose {
  private feet: FootIK;
  private head: HeadLook;
  private saved: Array<{ bone: THREE.Bone; position: THREE.Vector3; rotation: THREE.Quaternion }>;
  private applied = false;

  constructor(private root: THREE.Object3D, skeleton: THREE.Skeleton, stature: number) {
    this.feet = new FootIK(root, skeleton, stature);
    this.head = new HeadLook(root, skeleton);
    this.saved = [...new Set([...this.feet.bones, ...this.head.bones])].map(bone => ({
      bone, position: new THREE.Vector3(), rotation: new THREE.Quaternion(),
    }));
  }

  /** Must run BEFORE AnimationMixer.update, including on the first disabled frame. */
  restore(): void {
    if (!this.applied) return;
    for (const { bone, position, rotation } of this.saved) {
      bone.position.copy(position);
      bone.quaternion.copy(rotation);
    }
    this.applied = false;
  }

  apply(dt: number, state: AnimState, frame: ProceduralFrame | null): void {
    // Default off in store cards/labs and NPCs, which have no world-ground context.
    if (!frame?.enabled || !frame.grounded || !['idle', 'walk', 'run'].includes(state)
      || !Number.isFinite(dt) || dt <= 0) {
      this.feet.reset();
      this.head.reset();
      return;
    }
    for (const { bone, position, rotation } of this.saved) {
      position.copy(bone.position);
      rotation.copy(bone.quaternion);
    }
    this.applied = true;
    this.root.updateWorldMatrix(true, true);
    if (frame.ground) this.feet.apply(Math.min(dt, 0.1), frame.ground);
    this.head.apply(Math.min(dt, 0.1), frame.lookTarget);
  }
}
