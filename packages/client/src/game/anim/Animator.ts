import * as THREE from 'three';
import type { AnimState } from '@streampolis/shared';
import type { BuiltRig } from '../avatar/Skeleton.js';
import { LOCOMOTION, LOOPING } from './Clips.js';
import { clipsForRig, type ClipSet } from './Library.js';

/**
 * The state machine that turns "Ana is dancing" into Ana dancing.
 *
 * The multiplayer state carries an `anim` per player and the renderer used to
 * ignore it, which meant a client could *know* a remote was dancing and still
 * draw them standing still. This is the missing half: one mixer per avatar,
 * crossfades between looping states, one-shots that play once and hand control
 * back, and a locomotion rate driven by how fast the body is really moving —
 * the only thing that stops a walk cycle from skating over the floor.
 */

/** Below this the body counts as standing still. */
const STILL = 0.18;
/** Above this a walk becomes a run, matching MAX_SPEED in the protocol. */
const RUN_AT = 3.1;
/** A gesture is abandoned the moment the player walks away from it. */
const CANCEL_AT = 0.9;

const FADE = 0.22;
const ONE_SHOT_FADE = 0.14;

export class Animator {
  readonly mixer: THREE.AnimationMixer;

  private clips: ClipSet;
  private actions = new Map<AnimState, THREE.AnimationAction>();
  /** The looping state underneath everything: idle, walk, run, sit, dance… */
  private base: AnimState = 'idle';
  private oneShot: AnimState | null = null;
  private requested: AnimState = 'idle';
  private lastRequest: AnimState = 'idle';
  /** Review override: pins one state and ignores how fast the body moves. */
  private pinned: AnimState | null = null;
  private speed = 0;

  constructor(root: THREE.Object3D, rig: BuiltRig) {
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = clipsForRig(rig);
    this.action('idle').play();
    this.mixer.addEventListener('finished', this.onFinished);
  }

  private action(state: AnimState): THREE.AnimationAction {
    let hit = this.actions.get(state);
    if (hit) return hit;
    hit = this.mixer.clipAction(this.clips[state].clip);
    if (LOOPING.has(state)) {
      hit.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      hit.setLoop(THREE.LoopOnce, 1);
      hit.clampWhenFinished = true;
    }
    this.actions.set(state, hit);
    return hit;
  }

  private onFinished = (e: { action: THREE.AnimationAction }) => {
    const finished = [...this.actions.entries()].find(([, a]) => a === e.action)?.[0];
    if (!finished || finished !== this.oneShot) return;
    this.oneShot = null;
    const back = this.action(this.base);
    back.enabled = true;
    back.setEffectiveWeight(1);
    back.fadeIn(ONE_SHOT_FADE).play();
    e.action.fadeOut(ONE_SHOT_FADE);
  };

  /** What the world says this avatar is doing. Cheap to call every frame. */
  request(state: AnimState): void {
    this.requested = state;
  }

  /**
   * Pins a state for the visual review loop. Without this, asking for `walk`
   * on a body that is standing still gets you `idle` — which is correct during
   * play and useless when the point is to photograph the walk.
   */
  pin(state: AnimState | null): void {
    this.pinned = state;
  }

  /** Current visible state, for the debug HUD and the screenshot tool. */
  get current(): AnimState {
    return this.oneShot ?? this.base;
  }

  /**
   * Advances the mixer. `speed` is metres per second measured from the pose
   * the renderer actually drew — not from an intent, and not from the server's
   * `moving` flag, because what must match the floor is the motion on screen.
   */
  update(dt: number, speed: number): void {
    this.speed = speed;

    const request = this.pinned ?? this.requested;
    const changed = request !== this.lastRequest;
    this.lastRequest = request;

    if (changed && !LOOPING.has(request)) {
      this.playOneShot(request);
    } else if (changed && this.oneShot) {
      // Asking for something else while a gesture plays interrupts it. Without
      // this, a wave keeps its arm up for two seconds after the player has
      // already started dancing.
      this.cancelOneShot();
    } else if (this.oneShot && !this.pinned && speed > CANCEL_AT) {
      // Walking out of a gesture cancels it, the way it does in every game
      // where the emote is not a cutscene.
      this.cancelOneShot();
    }

    const wanted = this.pinned === null && LOCOMOTION.has(request)
      ? this.locomotionFor(speed)
      : request;
    if (LOOPING.has(wanted) && wanted !== this.base) this.switchBase(wanted);

    this.applyRate();
    this.mixer.update(dt);
  }

  private locomotionFor(speed: number): AnimState {
    if (speed < STILL) return 'idle';
    return speed < RUN_AT ? 'walk' : 'run';
  }

  private switchBase(next: AnimState): void {
    const from = this.action(this.base);
    const to = this.action(next);
    to.enabled = true;
    to.setEffectiveTimeScale(1);
    to.setEffectiveWeight(1);
    if (this.oneShot) {
      // A gesture owns the body; the base changes underneath it silently.
      to.reset().play();
      to.setEffectiveWeight(0);
      from.stop();
    } else {
      to.reset().play();
      to.crossFadeFrom(from, FADE, true);
    }
    this.base = next;
  }

  private playOneShot(state: AnimState): void {
    const action = this.action(state);
    const from = this.action(this.oneShot ?? this.base);
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);
    action.play();
    action.crossFadeFrom(from, ONE_SHOT_FADE, true);
    this.oneShot = state;
  }

  private cancelOneShot(): void {
    if (!this.oneShot) return;
    const gesture = this.action(this.oneShot);
    const back = this.action(this.base);
    back.enabled = true;
    back.setEffectiveWeight(1);
    back.play();
    back.crossFadeFrom(gesture, ONE_SHOT_FADE, true);
    this.oneShot = null;
  }

  /**
   * Matches the walk's playback to the ground speed. The clip's own speed is
   * measured at compile time from how far the planted foot slides underneath
   * the hips, so this is a ratio of two real numbers rather than a guess.
   */
  private applyRate(): void {
    for (const state of ['walk', 'run'] as const) {
      const action = this.actions.get(state);
      if (!action) continue;
      const authored = Math.abs(this.clips[state].measure.baseSpeed);
      const rate = authored > 0.05 && this.pinned === null
        ? THREE.MathUtils.clamp(this.speed / authored, 0.55, 1.9)
        : 1;
      action.setEffectiveTimeScale(rate);
    }
  }

  dispose(): void {
    this.mixer.removeEventListener('finished', this.onFinished);
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.actions.clear();
  }
}
