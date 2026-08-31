import { PK_DURATION_MS, PK_OVERTIME_MS, type PKPhase, type PKResult } from '../shared.js';

/**
 * PK battle authority (SPECs §33, §68 regra 6).
 *
 * The engine owns the clock and the score. Clients render `phase`, `endsAt`
 * and the two totals and nothing else; there is no message a browser can send
 * that adds a point — points only enter through addPoints(), which the room
 * calls after the economy has already settled the gift.
 *
 * Pure with respect to time: `now` is injected, so the whole state machine is
 * testable without waiting three minutes.
 */

export type PKTeam = 'A' | 'B';

export const PK_COUNTDOWN_MS = 5_000;

export interface PKParticipant {
  id: string;
  name: string;
}

export type PKEvent =
  | { kind: 'phase'; phase: PKPhase }
  | { kind: 'score'; team: PKTeam; total: number; delta: number }
  | { kind: 'finished'; result: PKResult };

export interface PKSnapshot {
  phase: PKPhase;
  hostA: string;
  hostB: string;
  nameA: string;
  nameB: string;
  scoreA: number;
  scoreB: number;
  endsAt: number;
  winnerId: string;
}

export class PKEngine {
  private phase: PKPhase = 'WAITING';
  private a: PKParticipant = { id: '', name: '' };
  private b: PKParticipant = { id: '', name: '' };
  private scoreA = 0;
  private scoreB = 0;
  private endsAt = 0;
  private winnerId = '';
  private battleId = '';
  private overtimeUsed = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly durationMs = PK_DURATION_MS,
    private readonly overtimeMs = PK_OVERTIME_MS,
  ) {}

  get snapshot(): PKSnapshot {
    return {
      phase: this.phase,
      hostA: this.a.id,
      hostB: this.b.id,
      nameA: this.a.name,
      nameB: this.b.name,
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      endsAt: this.endsAt,
      winnerId: this.winnerId,
    };
  }

  get active(): boolean {
    return this.phase === 'ACTIVE' || this.phase === 'OVERTIME' || this.phase === 'COUNTDOWN';
  }

  get id(): string {
    return this.battleId;
  }

  /** Which side a receiver belongs to, or null when they are not in this PK. */
  teamOf(userId: string): PKTeam | null {
    if (userId && userId === this.a.id) return 'A';
    if (userId && userId === this.b.id) return 'B';
    return null;
  }

  /**
   * Opens a battle and starts the countdown. Refused while one is running —
   * a second start would silently reset the score of a live match.
   */
  start(a: PKParticipant, b: PKParticipant, battleId: string): PKEvent[] {
    if (this.active) return [];
    if (!a.id || !b.id || a.id === b.id) return [];
    this.a = { ...a };
    this.b = { ...b };
    this.scoreA = 0;
    this.scoreB = 0;
    this.winnerId = '';
    this.overtimeUsed = false;
    this.battleId = battleId;
    this.phase = 'COUNTDOWN';
    this.endsAt = this.now() + PK_COUNTDOWN_MS;
    return [{ kind: 'phase', phase: 'COUNTDOWN' }];
  }

  /**
   * Adds validated gift points. Only ACTIVE and OVERTIME count: a gift that
   * lands during the countdown is still charged (the coins left the wallet)
   * but must not decide a battle that has not begun.
   */
  addPoints(team: PKTeam, points: number): PKEvent[] {
    if (this.phase !== 'ACTIVE' && this.phase !== 'OVERTIME') return [];
    if (!Number.isFinite(points) || points <= 0) return [];
    const delta = Math.floor(points);
    if (team === 'A') this.scoreA += delta;
    else this.scoreB += delta;
    return [{ kind: 'score', team, total: team === 'A' ? this.scoreA : this.scoreB, delta }];
  }

  /** Convenience for the room: resolves the receiver to a side, then scores. */
  addPointsForReceiver(receiverId: string, points: number): PKEvent[] {
    const team = this.teamOf(receiverId);
    return team ? this.addPoints(team, points) : [];
  }

  /**
   * Advances the clock. The room calls this every tick; every phase change in
   * the product comes out of here, never out of a client message.
   */
  update(): PKEvent[] {
    if (this.phase === 'WAITING' || this.phase === 'FINISHED') return [];
    const t = this.now();
    if (t < this.endsAt) return [];

    if (this.phase === 'COUNTDOWN') {
      this.phase = 'ACTIVE';
      this.endsAt = t + this.durationMs;
      return [{ kind: 'phase', phase: 'ACTIVE' }];
    }

    // A draw at regular time buys one overtime, and exactly one: two teams
    // that never score would otherwise extend forever.
    if (this.phase === 'ACTIVE' && this.scoreA === this.scoreB && !this.overtimeUsed) {
      this.overtimeUsed = true;
      this.phase = 'OVERTIME';
      this.endsAt = t + this.overtimeMs;
      return [{ kind: 'phase', phase: 'OVERTIME' }];
    }

    return this.finish(t);
  }

  /** Ends the battle early (a host disconnected, an admin stopped it). */
  abort(reason: 'host_left' | 'admin'): PKEvent[] {
    if (!this.active) return [];
    if (reason === 'host_left') {
      // Walking out does not hand you a draw: the side still present wins.
      if (this.scoreA === this.scoreB) return this.finish(this.now());
    }
    return this.finish(this.now());
  }

  private finish(t: number): PKEvent[] {
    const draw = this.scoreA === this.scoreB;
    this.phase = 'FINISHED';
    this.endsAt = t;
    this.winnerId = draw ? '' : this.scoreA > this.scoreB ? this.a.id : this.b.id;
    const loserId = draw ? '' : this.winnerId === this.a.id ? this.b.id : this.a.id;
    const result: PKResult = {
      battleId: this.battleId,
      winnerId: this.winnerId,
      loserId,
      scoreA: this.scoreA,
      scoreB: this.scoreB,
      draw,
      finishedAt: t,
    };
    return [
      { kind: 'phase', phase: 'FINISHED' },
      { kind: 'finished', result },
    ];
  }

  /** Clears a finished battle so the room can host another one. */
  reset(): void {
    this.phase = 'WAITING';
    this.a = { id: '', name: '' };
    this.b = { id: '', name: '' };
    this.scoreA = 0;
    this.scoreB = 0;
    this.endsAt = 0;
    this.winnerId = '';
    this.battleId = '';
    this.overtimeUsed = false;
  }
}
