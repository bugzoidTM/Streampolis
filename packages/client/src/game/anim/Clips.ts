import type { AnimState } from '@streampolis/shared';
import { mirror, pose, type ClipSpec, type Pose } from './Pose.js';

/**
 * The clip catalogue, authored as data.
 *
 * There is no animation GLB in this project (SPECs §44 budgets 20 MB for the
 * whole first play), so every pose below is written by hand in the vocabulary
 * `Pose.ts` defines: DEGREES, DELTAS FROM REST, on a body that faces +Z.
 *
 * The three signs that matter, and that this file gets wrong the moment anyone
 * edits it without reading them:
 *   - a limb chain points DOWN, so +X swings it BACKWARD and -X forward;
 *   - the spine points UP, so +X leans the torso FORWARD;
 *   - +Z swings a limb toward +X: outward on the left, inward on the right.
 *
 * Locomotion is authored as one half-cycle and mirrored, because the only way
 * to guarantee both sides of a walk match is to write one of them.
 */

// ---------------------------------------------------------------------------
// Idle
// ---------------------------------------------------------------------------

/** Weight on one leg, chest lifted a little. A symmetric idle reads as a doll. */
const IDLE_A: Pose = {
  Hips: [0, 1.5, -1.2],
  Spine: [-1.0, 0, 0.8],
  Spine1: [0.6, 0, 0.5],
  Spine2: [0, 1.2, 0],
  Neck: [1.0, -1.0, 0],
  Head: [-0.5, 1.5, 0],
  LeftArm: [-2, 0, 2.5],
  LeftForeArm: [-6, 0, 3],
  RightArm: [1, 0, -1.5],
  RightForeArm: [-9, 0, -2],
  LeftUpLeg: [0, 0, -1],
  LeftLeg: [2, 0, 0],
  RightUpLeg: [-1.5, 3, 1.5],
  RightLeg: [5, 0, 0],
  RightFoot: [-1.5, 0, 0],
};

const IDLE_B: Pose = {
  Hips: [0.6, -1.2, -0.6],
  Spine: [0.8, 0, -0.6],
  Spine1: [-0.4, 0, -0.4],
  Spine2: [0, -0.8, 0],
  Neck: [-0.6, 0.8, 0],
  Head: [1.0, -1.2, 0],
  LeftArm: [1.5, 0, 1.2],
  LeftForeArm: [-8, 0, 2],
  RightArm: [-1.5, 0, -2.5],
  RightForeArm: [-6, 0, -3],
  LeftUpLeg: [-1, 0, -1.5],
  LeftLeg: [4, 0, 0],
  RightUpLeg: [0, 3, 1],
  RightLeg: [3, 0, 0],
  RightFoot: [-1, 0, 0],
};

export const IDLE: ClipSpec = {
  name: 'idle',
  duration: 4.6,
  loop: true,
  ground: 'lock',
  steps: 6,
  keys: [
    { time: 0.0, pose: IDLE_A, ease: 'sine' },
    { time: 2.3, pose: IDLE_B, ease: 'sine' },
  ],
  hips: [
    { time: 0.0, offset: [0.012, 0, 0] },
    { time: 2.3, offset: [-0.008, 0.004, 0] },
  ],
};

// ---------------------------------------------------------------------------
// Walk and run
// ---------------------------------------------------------------------------

/** Contact: left heel down in front, right toe still pushing off behind. */
const WALK_CONTACT: Pose = {
  Hips: [0, -2.5, 0],
  Spine: [2, 3, 0],
  Spine2: [0, -4, 0],
  Neck: [-1, 0, 0],

  // Heel strike in front, toe still on the floor behind. Both soles have to
  // be at ground level at this key: if the back toe dips lower than the front
  // heel, the ground lock hangs the whole body off the wrong foot and the
  // compiler decides the weight changes feet three samples too late.
  LeftUpLeg: [-22, 0, -1],
  LeftLeg: [2, 0, 0],
  LeftFoot: [-3, 0, 0],
  RightUpLeg: [19, 0, 1],
  RightLeg: [26, 0, 0],
  RightFoot: [14, 0, 0],

  LeftShoulder: [2, 0, 0],
  LeftArm: [19, 0, 3],
  LeftForeArm: [-14, 0, 4],
  RightShoulder: [-2, 0, 0],
  RightArm: [-20, 0, -3],
  RightForeArm: [-26, 0, -4],
};

/** Passing: stance leg straight under the hips, swing knee up and clear. */
const WALK_PASS: Pose = {
  Hips: [0, 0, 0],
  Spine: [1.5, 0, 0],
  LeftUpLeg: [-3, 0, -1],
  LeftLeg: [3, 0, 0],
  LeftFoot: [0, 0, 0],
  RightUpLeg: [-4, 0, 1],
  RightLeg: [40, 0, 0],
  RightFoot: [-12, 0, 0],
  LeftArm: [4, 0, 3],
  LeftForeArm: [-16, 0, 4],
  RightArm: [-5, 0, -3],
  RightForeArm: [-18, 0, -4],
};

export const WALK: ClipSpec = {
  name: 'walk',
  duration: 1.02,
  loop: true,
  ground: 'lock',
  locomotion: true,
  steps: 5,
  // Linear, not eased. A planted foot has to travel backwards at a CONSTANT
  // rate — easing between contact and passing is what makes the body skate
  // over its own foot, and no amount of correction afterwards recovers the
  // motion that was never authored.
  keys: [
    { time: 0.0, pose: WALK_CONTACT, ease: 'linear' },
    { time: 0.255, pose: WALK_PASS, ease: 'linear' },
    { time: 0.51, pose: mirror(WALK_CONTACT), ease: 'linear' },
    { time: 0.765, pose: mirror(WALK_PASS), ease: 'linear' },
  ],
  hips: [
    // Lateral sway toward the stance leg. Without it a walk reads as a
    // marionette sliding along a rail.
    { time: 0.0, offset: [0.02, 0, 0] },
    { time: 0.51, offset: [-0.02, 0, 0] },
  ],
};

const RUN_CONTACT: Pose = {
  Hips: [0, -3, 0],
  Spine: [9, 4, 0],
  Spine1: [3, 0, 0],
  Spine2: [0, -6, 0],
  Neck: [-6, 0, 0],
  Head: [-3, 0, 0],

  LeftUpLeg: [-38, 0, -2],
  LeftLeg: [22, 0, 0],
  LeftFoot: [-6, 0, 0],
  RightUpLeg: [30, 0, 2],
  RightLeg: [34, 0, 0],
  RightFoot: [22, 0, 0],

  LeftShoulder: [4, 0, 0],
  LeftArm: [34, 0, 6],
  LeftForeArm: [-78, 0, 6],
  RightShoulder: [-4, 0, 0],
  RightArm: [-38, 0, -6],
  RightForeArm: [-84, 0, -6],
};

/** Flight: both feet off the floor, knees folded, body at its highest. */
const RUN_FLIGHT: Pose = {
  Hips: [0, 0, 0],
  Spine: [10, 0, 0],
  Neck: [-6, 0, 0],
  LeftUpLeg: [10, 0, -2],
  LeftLeg: [56, 0, 0],
  LeftFoot: [10, 0, 0],
  RightUpLeg: [-14, 0, 2],
  RightLeg: [72, 0, 0],
  RightFoot: [-10, 0, 0],
  LeftArm: [6, 0, 6],
  LeftForeArm: [-88, 0, 6],
  RightArm: [-8, 0, -6],
  RightForeArm: [-88, 0, -6],
};

export const RUN: ClipSpec = {
  name: 'run',
  duration: 0.68,
  loop: true,
  locomotion: true,
  // 'plant' only ever lifts the body, so the flight phase survives compilation.
  ground: 'plant',
  steps: 5,
  keys: [
    { time: 0.0, pose: RUN_CONTACT, ease: 'linear' },
    { time: 0.17, pose: RUN_FLIGHT, ease: 'linear' },
    { time: 0.34, pose: mirror(RUN_CONTACT), ease: 'linear' },
    { time: 0.51, pose: mirror(RUN_FLIGHT), ease: 'linear' },
  ],
  hips: [
    { time: 0.0, offset: [0.012, -0.02, 0] },
    { time: 0.17, offset: [0, 0.03, 0] },
    { time: 0.34, offset: [-0.012, -0.02, 0] },
    { time: 0.51, offset: [0, 0.03, 0] },
  ],
};

// ---------------------------------------------------------------------------
// Sitting
// ---------------------------------------------------------------------------

const SIT_BASE: Pose = {
  Spine: [6, 0, 0],
  Spine1: [3, 0, 0],
  Spine2: [-2, 0, 0],
  Neck: [-3, 0, 0],
  LeftUpLeg: [-86, 0, -6],
  LeftLeg: [84, 0, 0],
  LeftFoot: [6, 0, 0],
  RightUpLeg: [-86, 0, 6],
  RightLeg: [84, 0, 0],
  RightFoot: [6, 0, 0],
  LeftArm: [-14, 0, 6],
  LeftForeArm: [-42, 0, 8],
  RightArm: [-14, 0, -6],
  RightForeArm: [-42, 0, -8],
};

export const SIT: ClipSpec = {
  name: 'sit',
  duration: 5.0,
  loop: true,
  // No ground lock: the hips are held at seat height on purpose, and locking
  // the soles to the floor would stand the avatar back up.
  ground: 'off',
  steps: 4,
  keys: [
    { time: 0.0, pose: SIT_BASE, ease: 'sine' },
    {
      time: 2.5,
      pose: pose(SIT_BASE, {
        Spine: [4, 1.5, 0], Neck: [-1, -2, 0], Head: [1, 1.5, 0],
        LeftForeArm: [-46, 0, 8], RightForeArm: [-38, 0, -8],
      }),
      ease: 'sine',
    },
  ],
  hips: [
    // Seat height for a 0.45 m chair, as a fraction of hip height.
    { time: 0.0, offset: [0, -0.5, -0.16] },
    { time: 2.5, offset: [0, -0.5, -0.15] },
  ],
};

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

const WAVE_UP: Pose = {
  Spine: [0, -4, 0],
  Spine2: [0, -6, 0],
  Neck: [0, 3, 2],
  Head: [-2, 4, 3],
  RightShoulder: [0, 0, -8],
  RightArm: [-14, 0, -122],
  RightForeArm: [-16, -22, -18],
  RightHand: [0, 0, -12],
  LeftArm: [2, 0, 3],
  LeftForeArm: [-10, 0, 4],
};

export const WAVE: ClipSpec = {
  name: 'wave',
  duration: 2.0,
  ground: 'lock',
  steps: 4,
  keys: [
    { time: 0.0, pose: {}, ease: 'out' },
    { time: 0.34, pose: pose(WAVE_UP, { RightForeArm: [-16, -22, -34] }), ease: 'sine' },
    { time: 0.62, pose: pose(WAVE_UP, { RightForeArm: [-16, -22, 4] }), ease: 'sine' },
    { time: 0.9, pose: pose(WAVE_UP, { RightForeArm: [-16, -22, -34] }), ease: 'sine' },
    { time: 1.18, pose: pose(WAVE_UP, { RightForeArm: [-16, -22, 2] }), ease: 'sine' },
    { time: 1.5, pose: WAVE_UP, ease: 'in' },
    { time: 2.0, pose: {}, ease: 'sine' },
  ],
};

const CLAP_OPEN: Pose = {
  Spine: [3, 0, 0],
  Neck: [-2, 0, 0],
  LeftShoulder: [-4, 0, 0],
  LeftArm: [-56, 0, 26],
  LeftForeArm: [-78, 0, 22],
  RightShoulder: [-4, 0, 0],
  RightArm: [-56, 0, -26],
  RightForeArm: [-78, 0, -22],
};

const CLAP_SHUT: Pose = {
  Spine: [5, 0, 0],
  Neck: [-3, 0, 0],
  LeftShoulder: [-4, 0, 0],
  LeftArm: [-58, 0, 8],
  LeftForeArm: [-84, 0, 4],
  RightShoulder: [-4, 0, 0],
  RightArm: [-58, 0, -8],
  RightForeArm: [-84, 0, -4],
};

export const CLAP: ClipSpec = {
  name: 'clap',
  duration: 0.62,
  loop: true,
  ground: 'lock',
  steps: 3,
  keys: [
    { time: 0.0, pose: CLAP_SHUT, ease: 'out' },
    { time: 0.3, pose: CLAP_OPEN, ease: 'snap' },
  ],
};

// ---------------------------------------------------------------------------
// Dance — the emote that has to read from across the plaza
// ---------------------------------------------------------------------------

const DANCE_A: Pose = {
  Hips: [0, 8, -4],
  Spine: [-2, -6, 5],
  Spine1: [2, 0, 3],
  Spine2: [0, -8, 0],
  Neck: [-2, 4, -3],
  Head: [3, 6, -4],
  LeftShoulder: [-6, 0, 6],
  LeftArm: [-34, 0, 78],
  LeftForeArm: [-46, 0, 44],
  RightShoulder: [2, 0, 0],
  RightArm: [12, 0, -18],
  RightForeArm: [-56, 0, -20],
  LeftUpLeg: [-6, 0, -4],
  LeftLeg: [16, 0, 0],
  LeftFoot: [-4, 0, 0],
  RightUpLeg: [4, 0, 6],
  RightLeg: [6, 0, 0],
};

const DANCE_B: Pose = {
  Hips: [0, -8, 4],
  Spine: [3, 6, -5],
  Spine1: [-1, 0, -3],
  Spine2: [0, 8, 0],
  Neck: [-2, -4, 3],
  Head: [2, -6, 4],
  LeftShoulder: [2, 0, 0],
  LeftArm: [12, 0, 18],
  LeftForeArm: [-56, 0, 20],
  RightShoulder: [-6, 0, -6],
  RightArm: [-34, 0, -78],
  RightForeArm: [-46, 0, -44],
  LeftUpLeg: [4, 0, -6],
  LeftLeg: [6, 0, 0],
  RightUpLeg: [-6, 0, 4],
  RightLeg: [16, 0, 0],
  RightFoot: [-4, 0, 0],
};

export const DANCE: ClipSpec = {
  name: 'dance',
  duration: 1.72,
  loop: true,
  ground: 'lock',
  steps: 5,
  keys: [
    { time: 0.0, pose: DANCE_A, ease: 'out' },
    { time: 0.43, pose: pose(DANCE_A, { Hips: [0, 4, 0], Spine: [4, -2, 2] }), ease: 'in' },
    { time: 0.86, pose: DANCE_B, ease: 'out' },
    { time: 1.29, pose: pose(DANCE_B, { Hips: [0, -4, 0], Spine: [4, 2, -2] }), ease: 'in' },
  ],
  hips: [
    { time: 0.0, offset: [0.05, 0.01, 0] },
    { time: 0.43, offset: [0.02, -0.03, 0] },
    { time: 0.86, offset: [-0.05, 0.01, 0] },
    { time: 1.29, offset: [-0.02, -0.03, 0] },
  ],
};

// ---------------------------------------------------------------------------
// Reactions and results
// ---------------------------------------------------------------------------

const ARMS_UP: Pose = {
  Spine: [-6, 0, 0],
  Spine1: [-3, 0, 0],
  Neck: [4, 0, 0],
  Head: [6, 0, 0],
  LeftShoulder: [-8, 0, 10],
  LeftArm: [-10, 0, 158],
  LeftForeArm: [-14, 0, 12],
  RightShoulder: [-8, 0, -10],
  RightArm: [-10, 0, -158],
  RightForeArm: [-14, 0, -12],
  LeftUpLeg: [-4, 0, -2],
  RightUpLeg: [-4, 0, 2],
  LeftLeg: [6, 0, 0],
  RightLeg: [6, 0, 0],
};

export const CELEBRATE: ClipSpec = {
  name: 'celebrate',
  duration: 1.9,
  ground: 'plant',
  steps: 5,
  keys: [
    { time: 0.0, pose: {}, ease: 'wind' },
    // Anticipation: everything crouches before it goes up.
    { time: 0.22, pose: { Spine: [12, 0, 0], LeftUpLeg: [-18, 0, 0], RightUpLeg: [-18, 0, 0], LeftLeg: [34, 0, 0], RightLeg: [34, 0, 0], LeftArm: [22, 0, 4], RightArm: [22, 0, -4] }, ease: 'snap' },
    { time: 0.48, pose: ARMS_UP, ease: 'over' },
    { time: 0.95, pose: pose(ARMS_UP, { Spine: [-4, 4, 0], Head: [4, 6, 0] }), ease: 'sine' },
    { time: 1.35, pose: pose(ARMS_UP, { Spine: [-4, -4, 0], Head: [4, -6, 0] }), ease: 'sine' },
    { time: 1.9, pose: {}, ease: 'sine' },
  ],
  hips: [
    { time: 0.0, offset: [0, 0, 0] },
    { time: 0.22, offset: [0, -0.18, 0] },
    { time: 0.48, offset: [0, 0.16, 0], ease: 'out' },
    { time: 0.72, offset: [0, 0, 0], ease: 'in' },
    { time: 1.9, offset: [0, 0, 0] },
  ],
};

export const GIFT_REACT: ClipSpec = {
  name: 'giftReact',
  duration: 1.5,
  ground: 'lock',
  steps: 4,
  keys: [
    { time: 0.0, pose: {}, ease: 'snap' },
    // Recoil first, hands to the face second: surprise is a body before it is
    // a gesture.
    {
      time: 0.18,
      pose: {
        Spine: [-10, 0, 0], Neck: [6, 0, 0], Head: [8, 0, 0],
        LeftArm: [-40, 0, 30], LeftForeArm: [-96, 0, 26],
        RightArm: [-40, 0, -30], RightForeArm: [-96, 0, -26],
        LeftUpLeg: [4, 0, 0], RightUpLeg: [4, 0, 0],
      },
      ease: 'out',
    },
    {
      time: 0.62,
      pose: {
        Spine: [2, 0, 0], Neck: [0, 0, 0], Head: [2, 0, 0],
        LeftArm: [-52, 0, 22], LeftForeArm: [-104, 0, 20],
        RightArm: [-52, 0, -22], RightForeArm: [-104, 0, -20],
      },
      ease: 'sine',
    },
    { time: 1.5, pose: {}, ease: 'sine' },
  ],
  hips: [
    { time: 0.0, offset: [0, 0, 0] },
    { time: 0.18, offset: [0, -0.02, -0.05] },
    { time: 0.62, offset: [0, 0, 0] },
  ],
};

export const PK_WIN: ClipSpec = {
  name: 'pkWin',
  duration: 2.6,
  ground: 'plant',
  steps: 5,
  keys: [
    { time: 0.0, pose: {}, ease: 'wind' },
    { time: 0.3, pose: { Spine: [10, 0, 0], LeftArm: [26, 0, 4], RightArm: [26, 0, -4], LeftLeg: [24, 0, 0], RightLeg: [24, 0, 0], LeftUpLeg: [-12, 0, 0], RightUpLeg: [-12, 0, 0] }, ease: 'snap' },
    { time: 0.6, pose: ARMS_UP, ease: 'over' },
    // Then the flex: elbows in, chest out, chin up. A win is a held pose.
    {
      time: 1.15,
      pose: {
        Spine: [-8, 0, 0], Spine1: [-4, 0, 0], Neck: [6, 0, 0], Head: [8, 0, 0],
        LeftShoulder: [-10, 0, 14], LeftArm: [-16, 0, 88], LeftForeArm: [-118, 0, 16],
        RightShoulder: [-10, 0, -14], RightArm: [-16, 0, -88], RightForeArm: [-118, 0, -16],
        LeftUpLeg: [-2, 0, -6], RightUpLeg: [-2, 0, 6], LeftLeg: [8, 0, 0], RightLeg: [8, 0, 0],
      },
      ease: 'over',
    },
    {
      time: 2.0,
      pose: {
        Spine: [-8, 3, 0], Neck: [6, -2, 0], Head: [8, 3, 0],
        LeftShoulder: [-10, 0, 14], LeftArm: [-16, 0, 88], LeftForeArm: [-122, 0, 16],
        RightShoulder: [-10, 0, -14], RightArm: [-16, 0, -88], RightForeArm: [-122, 0, -16],
      },
      ease: 'sine',
    },
    { time: 2.6, pose: {}, ease: 'sine' },
  ],
  hips: [
    { time: 0.0, offset: [0, 0, 0] },
    { time: 0.3, offset: [0, -0.14, 0] },
    { time: 0.6, offset: [0, 0.12, 0], ease: 'out' },
    { time: 0.9, offset: [0, 0, 0], ease: 'in' },
  ],
};

export const PK_LOSE: ClipSpec = {
  name: 'pkLose',
  duration: 2.8,
  ground: 'lock',
  steps: 5,
  keys: [
    { time: 0.0, pose: {}, ease: 'out' },
    {
      time: 0.5,
      pose: {
        Spine: [22, 0, 0], Spine1: [10, 0, 0], Spine2: [6, 0, 0],
        Neck: [12, 0, 0], Head: [16, 0, 0],
        LeftArm: [-18, 0, 14], LeftForeArm: [-30, 0, 10],
        RightArm: [-18, 0, -14], RightForeArm: [-30, 0, -10],
        LeftUpLeg: [-16, 0, -4], RightUpLeg: [-16, 0, 4],
        LeftLeg: [26, 0, 0], RightLeg: [26, 0, 0],
        LeftFoot: [-6, 0, 0], RightFoot: [-6, 0, 0],
      },
      ease: 'sine',
    },
    {
      time: 1.6,
      pose: {
        Spine: [24, 0, 2], Spine1: [11, 0, 0], Neck: [13, 0, 0], Head: [18, 0, -2],
        LeftArm: [-20, 0, 14], LeftForeArm: [-32, 0, 10],
        RightArm: [-16, 0, -14], RightForeArm: [-28, 0, -10],
        LeftUpLeg: [-16, 0, -4], RightUpLeg: [-16, 0, 4],
        LeftLeg: [26, 0, 0], RightLeg: [26, 0, 0],
      },
      ease: 'sine',
    },
    { time: 2.8, pose: {}, ease: 'sine' },
  ],
  hips: [
    { time: 0.0, offset: [0, 0, 0] },
    { time: 0.5, offset: [0, -0.08, -0.04] },
    { time: 1.6, offset: [0, -0.09, -0.04] },
    { time: 2.8, offset: [0, 0, 0] },
  ],
};

/** Every state the protocol can put on the wire has a clip. */
export const CLIP_SPECS: Record<AnimState, ClipSpec> = {
  idle: IDLE,
  walk: WALK,
  run: RUN,
  sit: SIT,
  wave: WAVE,
  clap: CLAP,
  dance: DANCE,
  celebrate: CELEBRATE,
  giftReact: GIFT_REACT,
  pkWin: PK_WIN,
  pkLose: PK_LOSE,
};

/** Clips that loop until something else is asked for. */
export const LOOPING: ReadonlySet<AnimState> = new Set<AnimState>([
  'idle', 'walk', 'run', 'sit', 'dance', 'clap',
]);

/** Clips chosen by how fast the body is actually moving. */
export const LOCOMOTION: ReadonlySet<AnimState> = new Set<AnimState>(['idle', 'walk', 'run']);
