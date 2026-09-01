import * as THREE from 'three';

/**
 * One standardised humanoid rig for every avatar part (SPECs §13). Names
 * follow the Mixamo convention so externally authored GLB clothing or
 * animation can be dropped in later without a retarget step.
 */
export const BONE_NAMES = [
  'Hips',
  'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Local rest offsets in metres, for a nominal 1.72 m adult. */
interface BoneDef { parent: BoneName | null; pos: [number, number, number]; }

const D = (parent: BoneName | null, x: number, y: number, z: number): BoneDef =>
  ({ parent, pos: [x, y, z] });

export const REST: Record<BoneName, BoneDef> = {
  Hips:         D(null,        0,     0.935, 0),
  Spine:        D('Hips',      0,     0.092, 0),
  Spine1:       D('Spine',     0,     0.112, 0),
  Spine2:       D('Spine1',   0,     0.122, 0),
  Neck:         D('Spine2',    0,     0.115, 0.006),
  Head:         D('Neck',      0,     0.075, 0.012),
  HeadTop_End:  D('Head',      0,     0.215, 0),

  LeftShoulder: D('Spine2',    0.058, 0.082, 0),
  LeftArm:      D('LeftShoulder', 0.128, 0.004, 0),
  LeftForeArm:  D('LeftArm',   0,    -0.272, 0),
  LeftHand:     D('LeftForeArm', 0,  -0.248, 0),

  RightShoulder: D('Spine2',  -0.058, 0.082, 0),
  RightArm:      D('RightShoulder', -0.128, 0.004, 0),
  RightForeArm:  D('RightArm',  0,   -0.272, 0),
  RightHand:     D('RightForeArm', 0, -0.248, 0),

  // Stance width. 0.092 put the femur heads so close together that a heavy
  // preset's thighs overlapped all the way past the knee — no amount of
  // radius tuning opens a gap the skeleton does not allow. 0.101 is still
  // inside the anatomical range and buys ~2 cm of daylight per side.
  LeftUpLeg:    D('Hips',      0.101, -0.058, 0),
  LeftLeg:      D('LeftUpLeg', 0,    -0.398, 0),
  LeftFoot:     D('LeftLeg',   0,    -0.392, -0.012),
  LeftToeBase:  D('LeftFoot',  0,    -0.075,  0.128),

  RightUpLeg:   D('Hips',     -0.101, -0.058, 0),
  RightLeg:     D('RightUpLeg', 0,   -0.398, 0),
  RightFoot:    D('RightLeg',  0,    -0.392, -0.012),
  RightToeBase: D('RightFoot', 0,    -0.075,  0.128),
};

/**
 * Relaxed A-pose rest rotations. Modelling in A-pose rather than T-pose keeps
 * the shoulder deltoid from tearing when the arm drops to idle, which is the
 * pose the avatar spends most of its time in.
 */
export const REST_ROTATION: Partial<Record<BoneName, [number, number, number]>> = {
  // The arm chain's local offsets already point down (-Y), so the rest pose is
  // arms-at-side. These rotations only splay the arms clear of the ribcage —
  // rotating the shoulder by a full 70 degrees would swing the chain out into
  // a T-pose, which is not what the offsets describe.
  // A positive Z rotation swings a down-pointing chain toward +X, so the LEFT
  // (+X) side takes the positive angle. Getting this backwards folds both arms
  // into the ribcage, which is exactly what the first pass did.
  //
  // The elbow carries real flexion. An arm that hangs straight is a plumb
  // line, and a plumb line is a mannequin: nobody stands with the elbow
  // locked, and the bend is what tells the eye the figure has weight in it.
  LeftShoulder:  [0, 0, THREE.MathUtils.degToRad(3)],
  RightShoulder: [0, 0, THREE.MathUtils.degToRad(-3)],
  LeftArm:       [0, 0, THREE.MathUtils.degToRad(9)],
  RightArm:      [0, 0, THREE.MathUtils.degToRad(-9)],
  LeftForeArm:   [THREE.MathUtils.degToRad(-15), 0, THREE.MathUtils.degToRad(4)],
  RightForeArm:  [THREE.MathUtils.degToRad(-15), 0, THREE.MathUtils.degToRad(-4)],
  // Legs converge very slightly toward the ankle, as a relaxed stance does.
  // Kept small: every degree of convergence is a centimetre the two shoes
  // move toward each other at the ankle, and they were already touching.
  LeftUpLeg:     [0, 0, THREE.MathUtils.degToRad(-0.9)],
  RightUpLeg:    [0, 0, THREE.MathUtils.degToRad(0.9)],
};

export interface RigProportions {
  /** Overall scale multiplier applied to every bone offset. */
  height: number;
  /** >1 widens the shoulders relative to the hips. */
  shoulderWidth: number;
  hipWidth: number;
  /** >1 lengthens the legs at the expense of torso proportion. */
  legLength: number;
  armLength: number;
  neckLength: number;
  headScale: number;
}

export const PROPORTION_PRESETS: RigProportions[] = [
  // 0 — balanced
  { height: 1.0,  shoulderWidth: 1.0,  hipWidth: 1.0,  legLength: 1.0,  armLength: 1.0,  neckLength: 1.0,  headScale: 1.0 },
  // 1 — broader, heavier build
  { height: 1.04, shoulderWidth: 1.14, hipWidth: 1.06, legLength: 0.97, armLength: 1.02, neckLength: 0.94, headScale: 0.97 },
  // 2 — slighter, longer-limbed
  { height: 0.97, shoulderWidth: 0.9,  hipWidth: 1.05, legLength: 1.05, armLength: 1.02, neckLength: 1.06, headScale: 1.02 },
  // 3 — compact
  { height: 0.93, shoulderWidth: 0.97, hipWidth: 1.0,  legLength: 0.94, armLength: 0.96, neckLength: 0.96, headScale: 1.06 },
];

const SHOULDER_BONES: BoneName[] = ['LeftShoulder', 'RightShoulder'];
const HIP_BONES: BoneName[] = ['LeftUpLeg', 'RightUpLeg'];
const LEG_BONES: BoneName[] = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];
const ARM_BONES: BoneName[] = ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'];

export interface BuiltRig {
  skeleton: THREE.Skeleton;
  bones: Record<BoneName, THREE.Bone>;
  root: THREE.Bone;
  /** Rest-pose world position of every bone, for mesh generation. */
  restWorld: Record<BoneName, THREE.Vector3>;
  proportions: RigProportions;
}

export function buildRig(p: RigProportions): BuiltRig {
  const bones = {} as Record<BoneName, THREE.Bone>;

  for (const name of BONE_NAMES) {
    const def = REST[name];
    const bone = new THREE.Bone();
    bone.name = name;
    let [x, y, z] = def.pos;

    if (SHOULDER_BONES.includes(name)) x *= p.shoulderWidth;
    if (HIP_BONES.includes(name)) x *= p.hipWidth;
    if (LEG_BONES.includes(name)) y *= p.legLength;
    if (ARM_BONES.includes(name)) y *= p.armLength;
    if (name === 'Neck' || name === 'Head') y *= p.neckLength;
    if (name === 'HeadTop_End') y *= p.headScale;
    if (name === 'Hips') y *= p.legLength;

    bone.position.set(x * p.height, y * p.height, z * p.height);
    const rot = REST_ROTATION[name];
    if (rot) bone.rotation.set(rot[0], rot[1], rot[2]);
    bones[name] = bone;
  }

  for (const name of BONE_NAMES) {
    const parent = REST[name].parent;
    if (parent) bones[parent].add(bones[name]);
  }

  const root = bones.Hips;
  root.updateMatrixWorld(true);

  const restWorld = {} as Record<BoneName, THREE.Vector3>;
  for (const name of BONE_NAMES) {
    restWorld[name] = new THREE.Vector3().setFromMatrixPosition(bones[name].matrixWorld);
  }

  const skeleton = new THREE.Skeleton(BONE_NAMES.map((n) => bones[n]));
  return { skeleton, bones, root, restWorld, proportions: p };
}

/** Index of a bone within the skeleton, for skin-index attributes. */
export const BONE_INDEX: Record<BoneName, number> = Object.fromEntries(
  BONE_NAMES.map((n, i) => [n, i]),
) as Record<BoneName, number>;
