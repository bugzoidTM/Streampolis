import * as THREE from 'three';
import type { GroundSampler } from '../AvatarLike.js';
import { aimBone, aimBoneFrom, solveTwoBone } from './PoseMath.js';

interface Leg {
  upper: THREE.Bone;
  lower: THREE.Bone;
  foot: THREE.Bone;
  ankleHeight: number;
  contact: number;
  target: THREE.Vector3;
  orientation: THREE.Quaternion;
  detached: boolean;
  endpoint: THREE.Vector3;
}

/** Small visual corrections for grounded locomotion, measured in world metres. */
export class FootIK {
  readonly bones: THREE.Bone[] = [];
  private legs: Leg[] = [];
  private hips: THREE.Bone | undefined;
  private pelvis = 0;
  private origin = new THREE.Vector3();
  private hip = new THREE.Vector3();
  private knee = new THREE.Vector3();
  private ankle = new THREE.Vector3();
  private pole = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private solvedKnee = new THREE.Vector3();
  private solvedAnkle = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private rotation = new THREE.Quaternion();

  constructor(private root: THREE.Object3D, skeleton: THREE.Skeleton, private stature: number) {
    root.updateWorldMatrix(true, true);
    root.getWorldPosition(this.origin);
    // Streampolis attaches both thighs directly to Body. Hips only moves the
    // torso. Foot controls are siblings of Body under Root in both V2 rigs.
    this.hips = skeleton.bones.find(b => b.name === 'Body')
      ?? skeleton.bones.find(b => b.name === 'Hips');
    if (!this.hips) return;
    this.bones.push(this.hips);
    for (const side of ['L', 'R']) {
      const find = (name: string) => skeleton.bones.find(b => b.name === name
        || b.name === THREE.PropertyBinding.sanitizeNodeName(name));
      const upper = find(`UpperLeg.${side}`);
      const lower = find(`LowerLeg.${side}`);
      const foot = find(`Foot.${side}`);
      if (!upper || !lower || !foot || lower.parent !== upper) continue;
      const detached = foot.parent === this.hips.parent && upper.parent === this.hips;
      if (foot.parent !== lower && !detached) continue;
      const ankleHeight = foot.getWorldPosition(this.ankle).y - this.origin.y;
      // Unsupported/import-corrupt skeletons stay on authored animation.
      if (!Number.isFinite(ankleHeight) || ankleHeight < 0 || ankleHeight > stature * 0.25) continue;
      this.legs.push({ upper, lower, foot, ankleHeight, contact: 0,
        target: new THREE.Vector3(), orientation: new THREE.Quaternion(),
        detached, endpoint: new THREE.Vector3() });
      this.bones.push(upper, lower, foot);
    }
  }

  reset(): void {
    this.pelvis = 0;
    for (const leg of this.legs) leg.contact = 0;
  }

  apply(dt: number, sample: GroundSampler): void {
    if (!this.hips || !this.legs.length) return;
    const scale = this.stature / 1.72;
    const maxStep = 0.12 * scale;
    const smoothing = 1 - Math.exp(-Math.max(0, dt) / 0.08);
    let lowerPelvis = 0;
    for (const leg of this.legs) {
      leg.foot.getWorldPosition(leg.target);
      leg.foot.getWorldQuaternion(leg.orientation);
      // A virtual endpoint expressed in the CURRENT animated shin, before any
      // pelvis/leg correction. This preserves the exported detached hierarchy.
      leg.endpoint.copy(leg.target);
      leg.lower.worldToLocal(leg.endpoint);
      this.normal.set(0, 1, 0);
      const ground = sample(leg.target.x, leg.target.z, this.normal);
      const gap = ground === null ? Infinity : leg.target.y - ground - leg.ankleHeight;
      const valid = ground !== null && Number.isFinite(ground) && this.normal.y >= 0.7
        && Math.abs(gap) <= maxStep;
      const contact = valid ? 1 - THREE.MathUtils.smoothstep(Math.max(0, gap), 0.025 * scale, maxStep) : 0;
      leg.contact += (contact - leg.contact) * smoothing;
      // Never keep correcting into a hole, a jump, or an unsupported surface.
      if (!valid) leg.contact = 0;
      const correction = valid ? THREE.MathUtils.clamp(-gap, -maxStep, maxStep) * leg.contact : 0;
      leg.target.y += correction;
      lowerPelvis = Math.min(lowerPelvis, correction);
    }
    const desiredPelvis = Math.max(-0.065 * scale, lowerPelvis);
    this.pelvis += (desiredPelvis - this.pelvis) * smoothing;
    if (Math.abs(this.pelvis) > 1e-6 && this.hips.parent) {
      this.hips.getWorldPosition(this.hip);
      this.hip.y += this.pelvis;
      this.hips.position.copy(this.hips.parent.worldToLocal(this.hip));
      this.hips.updateWorldMatrix(false, true);
    }
    for (const leg of this.legs) {
      // Also preserve the swing trajectory when the planted leg lowers the hips.
      if (leg.contact < 0.001 && Math.abs(this.pelvis) < 1e-5) continue;
      leg.upper.getWorldPosition(this.hip);
      leg.lower.getWorldPosition(this.knee);
      this.ankle.copy(leg.endpoint);
      leg.lower.localToWorld(this.ankle);
      const upperLength = this.hip.distanceTo(this.knee);
      const lowerLength = this.knee.distanceTo(this.ankle);
      this.axis.subVectors(this.ankle, this.hip).normalize();
      this.pole.subVectors(this.knee, this.hip);
      this.pole.addScaledVector(this.axis, -this.pole.dot(this.axis));
      if (this.pole.lengthSq() < 1e-6) {
        this.pole.set(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(this.rotation));
      }
      if (!solveTwoBone(this.hip, leg.target, this.pole, upperLength, lowerLength,
        this.solvedKnee, this.solvedAnkle)) continue;
      aimBone(leg.upper, leg.lower, this.solvedKnee, Math.PI / 7);
      this.ankle.copy(leg.endpoint);
      leg.lower.localToWorld(this.ankle);
      aimBoneFrom(leg.lower, this.ankle, this.solvedAnkle, Math.PI / 4);
      if (leg.detached && leg.foot.parent) {
        // Use the achieved endpoint if a natural-angle/reach clamp intervened.
        this.ankle.copy(leg.endpoint);
        leg.lower.localToWorld(this.ankle);
        leg.foot.position.copy(leg.foot.parent.worldToLocal(this.ankle));
      }
      // Keep the authored sole orientation; IK must not turn a shoe with the shin.
      leg.foot.quaternion.copy(leg.foot.parent!.getWorldQuaternion(this.rotation).invert())
        .multiply(leg.orientation).normalize();
      leg.foot.updateWorldMatrix(false, true);
    }
  }
}
