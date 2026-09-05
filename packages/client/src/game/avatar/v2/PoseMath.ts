import * as THREE from 'three';

const EPS = 1e-7;
// Synchronous scratch space shared across avatars; these helpers never retain
// inputs or invoke callbacks, so a busy plaza does not allocate vectors per leg.
const solveAxis = new THREE.Vector3(), solveBend = new THREE.Vector3();
const worldRotation = new THREE.Quaternion(), parentRotation = new THREE.Quaternion();
const aimStart = new THREE.Vector3(), aimEndpoint = new THREE.Vector3();
const aimFrom = new THREE.Vector3(), aimTo = new THREE.Vector3();
const aimDelta = new THREE.Quaternion(), identity = new THREE.Quaternion();
const finiteVector = (v: THREE.Vector3) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** World-space two-bone triangle. The pole is a direction, not a position. */
export function solveTwoBone(
  hip: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3,
  upperLength: number, lowerLength: number, knee: THREE.Vector3, ankle: THREE.Vector3,
): boolean {
  if (!Number.isFinite(upperLength) || !Number.isFinite(lowerLength)
    || !finiteVector(hip) || !finiteVector(target) || !finiteVector(pole)
    || upperLength < EPS || lowerLength < EPS) return false;
  const axis = solveAxis.subVectors(target, hip);
  if (axis.lengthSq() < EPS * EPS) return false;
  const distance = THREE.MathUtils.clamp(axis.length(),
    Math.abs(upperLength - lowerLength) + EPS, upperLength + lowerLength - EPS);
  axis.normalize();
  const bend = solveBend.copy(pole).addScaledVector(axis, -pole.dot(axis));
  if (bend.lengthSq() < EPS * EPS) {
    bend.set(Math.abs(axis.x) < 0.8 ? 1 : 0, Math.abs(axis.x) < 0.8 ? 0 : 1, 0);
    bend.addScaledVector(axis, -bend.dot(axis));
  }
  bend.normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  knee.copy(hip).addScaledVector(axis, along).addScaledVector(bend, height);
  ankle.copy(hip).addScaledVector(axis, distance);
  return true;
}

/** Apply a world rotation even when an imported armature has rotated parents. */
export function rotateBoneWorld(bone: THREE.Bone, delta: THREE.Quaternion): void {
  const world = bone.getWorldQuaternion(worldRotation).premultiply(delta);
  if (bone.parent) world.premultiply(bone.parent.getWorldQuaternion(parentRotation).invert());
  bone.quaternion.copy(world).normalize();
  bone.updateWorldMatrix(false, true);
}

export function aimBone(
  bone: THREE.Bone, child: THREE.Bone, target: THREE.Vector3, maxAngle: number,
): void {
  const start = bone.getWorldPosition(aimStart);
  aimBoneFrom(bone, child.getWorldPosition(aimEndpoint), target, maxAngle, start);
}

/** Also supports exported rigs whose foot control is detached from the shin. */
export function aimBoneFrom(
  bone: THREE.Bone, endpoint: THREE.Vector3, target: THREE.Vector3, maxAngle: number,
  start = bone.getWorldPosition(aimStart),
): void {
  const from = aimFrom.subVectors(endpoint, start);
  const to = aimTo.subVectors(target, start);
  if (Math.min(from.lengthSq(), to.lengthSq()) < EPS) return;
  const delta = aimDelta.setFromUnitVectors(from.normalize(), to.normalize());
  const angle = delta.angleTo(identity);
  if (angle > maxAngle) delta.slerp(identity, 1 - maxAngle / angle);
  rotateBoneWorld(bone, delta);
}

/** Angle in the avatar's frame. Targets behind the shoulders are ignored. */
export function lookAngles(direction: THREE.Vector3): { yaw: number; pitch: number } {
  if (!finiteVector(direction) || direction.lengthSq() < EPS
    || direction.z <= 0) return { yaw: 0, pitch: 0 };
  return {
    yaw: THREE.MathUtils.clamp(Math.atan2(direction.x, direction.z), -Math.PI / 3, Math.PI / 3),
    pitch: THREE.MathUtils.clamp(-Math.atan2(direction.y, Math.hypot(direction.x, direction.z)),
      -Math.PI / 8, Math.PI / 7),
  };
}
