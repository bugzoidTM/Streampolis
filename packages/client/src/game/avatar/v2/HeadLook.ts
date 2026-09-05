import * as THREE from 'three';
import { lookAngles, rotateBoneWorld } from './PoseMath.js';

/** Bounded neck/head attention over the current clip; never edits a bind matrix. */
export class HeadLook {
  readonly bones: THREE.Bone[];
  private yaw = 0;
  private pitch = 0;
  private direction = new THREE.Vector3();
  private rootRotation = new THREE.Quaternion();
  private inverseRoot = new THREE.Quaternion();
  private axis = new THREE.Vector3();
  private delta = new THREE.Quaternion();
  private pitchDelta = new THREE.Quaternion();

  constructor(private root: THREE.Object3D, skeleton: THREE.Skeleton) {
    this.bones = ['Neck', 'Head'].map(name => skeleton.bones.find(b => b.name === name))
      .filter((bone): bone is THREE.Bone => !!bone);
  }

  reset(): void { this.yaw = this.pitch = 0; }

  apply(dt: number, target: THREE.Vector3 | null): void {
    const head = this.bones[this.bones.length - 1];
    if (!head) return;
    this.root.getWorldQuaternion(this.rootRotation);
    let wanted = { yaw: 0, pitch: 0 };
    if (target) {
      head.getWorldPosition(this.direction);
      this.direction.subVectors(target, this.direction).applyQuaternion(this.inverseRoot.copy(this.rootRotation).invert());
      wanted = lookAngles(this.direction);
    }
    const k = 1 - Math.exp(-Math.max(0, dt) / 0.15);
    this.yaw += (wanted.yaw - this.yaw) * k;
    this.pitch += (wanted.pitch - this.pitch) * k;
    for (const bone of this.bones) {
      const share = this.bones.length === 1 ? 1 : bone === head ? 0.65 : 0.35;
      this.axis.set(0, 1, 0).applyQuaternion(this.rootRotation);
      this.delta.setFromAxisAngle(this.axis, this.yaw * share);
      this.axis.set(1, 0, 0).applyQuaternion(this.rootRotation);
      this.pitchDelta.setFromAxisAngle(this.axis, this.pitch * share);
      this.delta.multiply(this.pitchDelta);
      rotateBoneWorld(bone, this.delta);
    }
  }
}
