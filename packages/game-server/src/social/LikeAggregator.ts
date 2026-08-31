import { LIKE_RATE_LIMIT } from '../shared.js';

/**
 * Likes are the cheapest and noisiest event in the product (SPECs §32): one
 * click per finger-tap, hundreds per second in a busy live. They are counted in
 * memory and flushed as a rolling total; nothing here writes a row per click,
 * and the counter is a projection — persistence is the API's periodic job.
 */
export class LikeAggregator {
  private total = 0;
  private sinceFlush = 0;
  private readonly perUser = new Map<string, number[]>();
  private readonly userTotals = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Registers up to `count` likes, honouring the per-user rate limit. Returns
   * how many were actually accepted — a client that spams simply gets fewer.
   */
  add(userId: string, count = 1): number {
    const requested = Number.isInteger(count) ? Math.max(0, Math.min(count, LIKE_RATE_LIMIT.likes)) : 0;
    if (requested === 0) return 0;

    const t = this.now();
    const windowStart = t - LIKE_RATE_LIMIT.windowMs;
    let stamps = this.perUser.get(userId);
    if (!stamps) this.perUser.set(userId, (stamps = []));
    let i = 0;
    while (i < stamps.length && (stamps[i] as number) <= windowStart) i++;
    if (i > 0) stamps.splice(0, i);

    const room = LIKE_RATE_LIMIT.likes - stamps.length;
    const accepted = Math.max(0, Math.min(requested, room));
    for (let k = 0; k < accepted; k++) stamps.push(t);

    this.total += accepted;
    this.sinceFlush += accepted;
    this.userTotals.set(userId, (this.userTotals.get(userId) ?? 0) + accepted);
    return accepted;
  }

  /** Pulls the delta accumulated since the last call. Broadcast this, not each click. */
  flush(): { total: number; delta: number } {
    const delta = this.sinceFlush;
    this.sinceFlush = 0;
    return { total: this.total, delta };
  }

  get count(): number {
    return this.total;
  }

  totalFor(userId: string): number {
    return this.userTotals.get(userId) ?? 0;
  }

  forget(userId: string): void {
    this.perUser.delete(userId);
  }
}
