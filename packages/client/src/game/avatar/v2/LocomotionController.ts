import * as THREE from 'three';

const NATIVE_WALK = 1.4;
const NATIVE_RUN = 3.6;
const BLEND_SECONDS = 0.12;
const NAMES = ['Idle', 'Walk', 'Run'] as const;

export interface LocomotionReport {
  speed: number;
  phase: number;
  weight: number;
  idle: number;
  walk: number;
  run: number;
}

/**
 * Three clips form one gait, driven by the speed actually drawn on screen.
 * The server still chooses gestures; it does not choose these visual weights.
 * Walk and run share a normalized phase so blending cannot mix opposite steps.
 */
export class LocomotionController {
  private readonly actions: Array<THREE.AnimationAction | null>;
  private readonly weights = [1, 0, 0];
  private readonly targets = [1, 0, 0];
  private phase = 0;
  private speed = 0;
  private weight = 1;
  private fadeFrom = 1;
  private fadeTo = 1;
  private fadeTime = 0;
  private fadeDuration = 0;

  constructor(mixer: THREE.AnimationMixer, clips: ReadonlyMap<string, THREE.AnimationClip>) {
    this.actions = NAMES.map((name) => {
      const clip = clips.get(name);
      if (!clip || clip.duration <= 0) return null;
      return mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity)
        .setEffectiveWeight(0).play();
    });
    // A missing clip must not leave part of the blend at the bind pose.
    if (!this.actions[0]) {
      this.weights[0] = 0;
      const first = this.actions.findIndex(Boolean);
      if (first >= 0) this.weights[first] = 1;
    }
    this.update(0, 0);
  }

  /** Fade the entire gait out for a gesture, preserving its phase for return. */
  setActive(active: boolean, seconds = 0.2): void {
    const target = active ? 1 : 0;
    this.fadeFrom = this.weight;
    this.fadeTo = target;
    this.fadeTime = 0;
    this.fadeDuration = Math.max(0, seconds);
    if (this.fadeDuration === 0) this.weight = target;
  }

  /** Call before mixer.update(); this class owns only the three gait actions. */
  update(dt: number, measuredSpeed: number): void {
    const seconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.speed = Number.isFinite(measuredSpeed) ? THREE.MathUtils.clamp(measuredSpeed, 0, 12) : 0;
    const moving = THREE.MathUtils.smoothstep(this.speed, 0.08, 0.65);
    // Walking input tops out at 2.4 m/s; it must remain a walk at that speed.
    const running = THREE.MathUtils.smoothstep(this.speed, 2.4, 4.2);
    this.targets[0] = 1 - moving;
    this.targets[1] = moving * (1 - running);
    this.targets[2] = moving * running;

    let sum = 0;
    for (let i = 0; i < 3; i++) {
      if (!this.actions[i]) this.targets[i] = 0;
      sum += this.targets[i];
    }
    if (sum <= 1e-8) {
      const fallback = this.actions.findIndex(Boolean);
      if (fallback >= 0) this.targets[fallback] = sum = 1;
    }
    const damping = 1 - Math.exp(-seconds / BLEND_SECONDS);
    for (let i = 0; i < 3; i++) {
      const target = sum > 0 ? this.targets[i] / sum : 0;
      this.weights[i] += (target - this.weights[i]) * damping;
    }

    this.fadeTime += seconds;
    const fade = this.fadeDuration > 0 ? Math.min(1, this.fadeTime / this.fadeDuration) : 1;
    this.weight = THREE.MathUtils.lerp(this.fadeFrom, this.fadeTo, fade);

    const walk = this.actions[1];
    const run = this.actions[2];
    const movingWeight = this.weights[1] + this.weights[2];
    if (movingWeight > 1e-6 && this.weight > 0) {
      const walkHz = walk ? this.speed / NATIVE_WALK / walk.getClip().duration : 0;
      const runHz = run ? this.speed / NATIVE_RUN / run.getClip().duration : 0;
      const hz = (walkHz * this.weights[1] + runHz * this.weights[2]) / movingWeight;
      this.phase = (this.phase + seconds * hz) % 1;
    }
    for (let i = 0; i < 3; i++) {
      const action = this.actions[i];
      if (!action) continue;
      action.setEffectiveWeight(this.weights[i] * this.weight);
      if (i > 0) {
        // Evaluate both at precisely the same step, without a second advance
        // when the caller updates the mixer later in this frame.
        action.time = this.phase * action.getClip().duration;
        action.setEffectiveTimeScale(0);
      }
    }
  }

  report(): LocomotionReport {
    return {
      speed: this.speed, phase: this.phase, weight: this.weight,
      idle: this.weights[0] * this.weight,
      walk: this.weights[1] * this.weight,
      run: this.weights[2] * this.weight,
    };
  }
}
