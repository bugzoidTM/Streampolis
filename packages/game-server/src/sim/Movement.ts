import {
  applyMoveIntent,
  clampYaw,
  FIXED_DT,
  INTENT_QUEUE_LIMIT,
  MAX_INTENTS_PER_TICK,
  MAX_SPEED,
  maxStepDistance,
  PLAYER_RADIUS,
  resolveCollision,
  type Area,
  type Bounds,
  type Collider,
  type Kinematic,
  type MoveIntent,
} from '../shared.js';

/** Why the server threw an intent away (SPECs §21). */
export type MoveRejectReason =
  | 'malformed'
  | 'stale_seq'
  | 'flood'
  | 'speed'
  | 'teleport'
  | 'out_of_area';

export interface Pose extends Kinematic {
  y: number;
}

/**
 * Sliding window of the sustained-speed audit. One second is long enough that
 * a jittery-but-honest client, whose intents arrive in bursts, is never
 * rewound; the price is that a cheater can hold up to one window's worth of
 * extra ground before the audit takes it back. Gains do not compound — every
 * audit clamps back to anchor + ceiling — so the bound over any interval is
 * `MAX_SPEED.run * tolerance * (elapsed + window)`.
 */
export const SPEED_AUDIT_WINDOW_MS = 1_000;

/**
 * Coerces whatever arrived on the socket into a MoveIntent, or null.
 * Anything non-finite is a lie or a bug; both get the same treatment.
 */
export function sanitizeIntent(raw: unknown): MoveIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const dx = r.dx, dz = r.dz, yaw = r.yaw, seq = r.seq;
  if (typeof dx !== 'number' || !Number.isFinite(dx)) return null;
  if (typeof dz !== 'number' || !Number.isFinite(dz)) return null;
  if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) return null;
  return { dx, dz, yaw: clampYaw(yaw), run: r.run === true, seq };
}

/** True when a single fixed step covered more ground than running allows. */
export function stepExceedsSpeed(from: { x: number; z: number }, to: { x: number; z: number }): boolean {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  // 1e-6 absorbs float noise at the exact ceiling; without it a legit sprint
  // trips the check roughly once per thousand ticks.
  return d > maxStepDistance() + 1e-6;
}

export function isInsideArea(p: { x: number; z: number }, area: Bounds): boolean {
  return p.x >= area.minX && p.x <= area.maxX && p.z >= area.minZ && p.z <= area.maxZ;
}

export interface StepOutcome {
  /** Pose after this tick — always the authoritative one. */
  pose: Pose;
  /** Highest intent sequence the server actually consumed. */
  lastSeq: number;
  /** Set when something was rejected and the client must hard-reset. */
  corrected: boolean;
  moved: boolean;
  rejections: MoveRejectReason[];
}

/**
 * Per-player movement authority.
 *
 * The client sends intents at a FIXED step; the server replays them with the
 * same step. That is what makes client prediction exact — with a wall-clock dt
 * on either side the two integrations drift and reconciliation turns into a
 * permanent rubber band.
 *
 * Anti-cheat lives here, not in the room: a client is free to send whatever it
 * likes, and none of it becomes truth until this class says so.
 */
export class MovementController {
  private queue: MoveIntent[] = [];
  private pose: Pose;
  private lastAcceptedSeq = 0;
  /** Sliding-window anchor for the teleport / sustained-speed audit. */
  private auditAnchor: { x: number; z: number; at: number };
  private pendingCorrection = false;
  /**
   * Há quanto tempo este jogador PEDE para andar e não sai do lugar, em ms.
   *
   * Não é a mesma coisa que estar parado: só conta quando o servidor consumiu
   * uma intenção de MOVIMENTO e a posição não mudou nem um milímetro. Quem está
   * encostado numa parede cai aqui também — e é por isso que quem lê este
   * número precisa confirmar com `penetrates` antes de fazer qualquer coisa.
   */
  private stuckSince = 0;

  readonly stats = { dropped: 0, flooded: 0, speedViolations: 0, teleports: 0 };

  constructor(
    spawn: Pose,
    private area: Bounds,
    private readonly now: () => number = Date.now,
    /**
     * Scene blockers. The server decides where a player may stand, and the
     * client predicts with this same table (SPECs §21) — without it a player
     * walks through the fountain on the server while bouncing off it locally.
     */
    private colliders: readonly Collider[] = [],
    private walkable: Area | null = null,
  ) {
    this.pose = { ...spawn };
    this.auditAnchor = { x: spawn.x, z: spawn.z, at: this.now() };
  }

  get current(): Readonly<Pose> {
    return this.pose;
  }

  get seq(): number {
    return this.lastAcceptedSeq;
  }

  /** Por quantos ms seguidos este corpo pediu para andar sem sair do lugar. */
  get stuckFor(): number {
    return this.stuckSince === 0 ? 0 : this.now() - this.stuckSince;
  }

  setArea(area: Bounds, colliders: readonly Collider[] = [], walkable: Area | null = null): void {
    this.area = area;
    this.colliders = colliders;
    this.walkable = walkable;
  }

  /** Force-move (spawn, teleport by the server, scene change). Resets the audit. */
  place(pose: Pose): void {
    this.pose = { ...pose };
    this.auditAnchor = { x: pose.x, z: pose.z, at: this.now() };
    this.pendingCorrection = true;
    this.stuckSince = 0;
  }

  /**
   * Accepts an intent for the next tick. Returns the reason it was refused, or
   * null when queued. Refusals are cheap on purpose — no exception, no
   * disconnect: a laggy client legitimately produces bursts and duplicates.
   */
  enqueue(raw: unknown): MoveRejectReason | null {
    const intent = sanitizeIntent(raw);
    if (!intent) {
      this.stats.dropped++;
      return 'malformed';
    }
    if (intent.seq <= this.lastAcceptedSeq) {
      this.stats.dropped++;
      return 'stale_seq';
    }
    if (this.queue.length >= INTENT_QUEUE_LIMIT) {
      // Someone is pushing far more than TICK_HZ intents per second. Drop the
      // NEW one, not the oldest: keeping the oldest preserves ordering and
      // means a flooder simply gets throttled to the legal rate.
      this.stats.flooded++;
      this.pendingCorrection = true;
      return 'flood';
    }
    this.queue.push(intent);
    return null;
  }

  /** Runs one server tick. Consumes at most MAX_INTENTS_PER_TICK intents. */
  step(): StepOutcome {
    const rejections: MoveRejectReason[] = [];
    let moved = false;
    const budget = Math.min(this.queue.length, MAX_INTENTS_PER_TICK);

    for (let i = 0; i < budget; i++) {
      const intent = this.queue.shift() as MoveIntent;
      const next = applyMoveIntent(this.pose, intent, this.area);

      // Speed is judged BEFORE collision: being pushed out of a blocker can
      // move a player further than they asked, and that is the server's own
      // doing, not a speed hack.
      if (stepExceedsSpeed(this.pose, next)) {
        // Unreachable through applyMoveIntent by construction; if it fires,
        // either MAX_SPEED changed under us or the integrator was tampered with.
        this.stats.speedViolations++;
        this.pendingCorrection = true;
        rejections.push('speed');
        this.lastAcceptedSeq = intent.seq;
        continue;
      }
      if (!isInsideArea(next, this.area)) {
        this.stats.dropped++;
        this.pendingCorrection = true;
        rejections.push('out_of_area');
        this.lastAcceptedSeq = intent.seq;
        continue;
      }

      // `this.pose` vai junto: passo que terminaria DENTRO de um móvel não
      // acontece, e o corpo fica onde estava. Ver `resolveCollision`.
      const solved = this.colliders.length > 0 || this.walkable
        ? resolveCollision(next, this.colliders, this.walkable, PLAYER_RADIUS, this.pose)
        : next;

      moved = moved || next.moving;
      // Pediu para andar e não andou? O relógio do encalhe começa a correr. Um
      // passo que sai do lugar zera tudo — inclusive um passo de meio milímetro
      // deslizando ao longo de uma parede, que é movimento legítimo.
      if (next.moving) {
        const saiu = Math.hypot(solved.x - this.pose.x, solved.z - this.pose.z) > 1e-6;
        if (saiu) this.stuckSince = 0;
        else if (this.stuckSince === 0) this.stuckSince = this.now();
      }
      this.pose = { x: solved.x, y: this.pose.y, z: solved.z, yaw: next.yaw, moving: next.moving };
      this.lastAcceptedSeq = intent.seq;
    }

    if (budget === 0 && this.queue.length === 0) {
      this.pose.moving = false;
    }

    if (this.auditSustainedSpeed()) {
      rejections.push('teleport');
    }

    const corrected = this.pendingCorrection;
    this.pendingCorrection = false;
    return { pose: { ...this.pose }, lastSeq: this.lastAcceptedSeq, corrected, moved, rejections };
  }

  /**
   * Guards against the shape of cheating a per-tick check cannot see: legal
   * single steps issued far faster than real time. Compares displacement since
   * the last anchor against the wall clock.
   */
  private auditSustainedSpeed(): boolean {
    const t = this.now();
    const elapsed = (t - this.auditAnchor.at) / 1000;
    if (elapsed < SPEED_AUDIT_WINDOW_MS / 1000) return false;

    const dx = this.pose.x - this.auditAnchor.x;
    const dz = this.pose.z - this.auditAnchor.z;
    const travelled = Math.hypot(dx, dz);
    const ceiling = MAX_SPEED.run * MAX_SPEED.tolerance * (elapsed + FIXED_DT);

    if (travelled > ceiling) {
      // Flagging is not enough. Bursts of intents are legal per tick (the
      // queue exists to absorb jitter), so a flooder gains ground that no
      // per-tick check can see; if the audit only raised a flag, that ground
      // would be permanent. Rewind to the furthest point the wall clock
      // allows, keeping the direction the player was heading.
      const k = ceiling / travelled;
      this.pose.x = this.auditAnchor.x + dx * k;
      this.pose.z = this.auditAnchor.z + dz * k;
      this.stats.teleports++;
      this.pendingCorrection = true;
      this.auditAnchor = { x: this.pose.x, z: this.pose.z, at: t };
      return true;
    }

    this.auditAnchor = { x: this.pose.x, z: this.pose.z, at: t };
    return false;
  }
}
