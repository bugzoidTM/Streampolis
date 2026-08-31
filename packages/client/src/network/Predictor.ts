import {
  applyMoveIntent,
  clampYaw,
  type Bounds,
  type Kinematic,
  type MoveCorrection,
  type MoveIntent,
} from '@streampolis/shared';

/**
 * Client-side prediction and reconciliation (SPECs §18).
 *
 * The local avatar must react on the same frame the key goes down — waiting a
 * round trip feels broken at any ping. So the client integrates the intent
 * immediately with `applyMoveIntent`, the *same* function the server runs, at
 * the *same* fixed step. That is the whole trick: two identical integrations
 * over identical inputs land on identical positions, so the usual case needs
 * no correction at all and the avatar never rubber-bands.
 *
 * A correction only arrives when the server actually overrode something. Then
 * the pending queue is replayed on top of the authoritative pose, so input the
 * player has already given is not thrown away.
 */
export class Predictor {
  private pose: Kinematic;
  private pending: MoveIntent[] = [];
  private seq = 0;
  /** Corrections applied so far — a debug overlay reads this. */
  private corrections = 0;

  constructor(spawn: Kinematic, private area: Bounds) {
    this.pose = { ...spawn };
  }

  get current(): Readonly<Kinematic> {
    return this.pose;
  }

  get stats(): { pending: number; corrections: number; seq: number } {
    return { pending: this.pending.length, corrections: this.corrections, seq: this.seq };
  }

  setArea(area: Bounds): void {
    this.area = area;
  }

  /** Hard reset — used on join and on a scene change. */
  place(pose: Kinematic): void {
    this.pose = { ...pose };
    this.pending = [];
  }

  /**
   * Produces one intent for this fixed step, applies it locally and keeps it
   * pending until the server confirms. Returns what to put on the wire.
   */
  step(dx: number, dz: number, yaw: number, run: boolean): MoveIntent {
    const intent: MoveIntent = { dx, dz, yaw: clampYaw(yaw), run, seq: ++this.seq };
    this.pose = applyMoveIntent(this.pose, intent, this.area);
    this.pending.push(intent);
    // A player that idles while the socket stalls would otherwise grow this
    // forever; the server only ever consumes a few per tick anyway.
    if (this.pending.length > 120) this.pending.shift();
    return intent;
  }

  /** Drops intents the server has consumed. Called on every correction. */
  private forget(seq: number): void {
    while (this.pending.length > 0 && (this.pending[0] as MoveIntent).seq <= seq) {
      this.pending.shift();
    }
  }

  /**
   * Applies the authoritative pose and replays whatever the server has not
   * seen yet. Snapping without the replay is what makes a corrected player
   * lurch backwards for one frame at every correction.
   */
  reconcile(correction: MoveCorrection): void {
    this.forget(correction.seq);
    this.corrections++;
    let pose: Kinematic = {
      x: correction.x,
      z: correction.z,
      yaw: clampYaw(correction.yaw),
      moving: this.pose.moving,
    };
    for (const intent of this.pending) {
      pose = applyMoveIntent(pose, intent, this.area);
    }
    this.pose = pose;
  }
}
