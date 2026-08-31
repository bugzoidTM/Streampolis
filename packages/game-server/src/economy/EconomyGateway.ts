import { GIFT_BY_ID } from '../shared.js';
import { config } from '../config.js';

/**
 * ECONOMY BOUNDARY — SPECs §68 regra 4 e 6, §25, §26, §27.
 *
 * The game server NEVER debits a wallet. It does not hold a balance, it does
 * not decide whether someone can afford a gift, and it never writes a ledger
 * row. What it does:
 *
 *   1. receives a GiftIntent from a client;
 *   2. asks the EconomyGateway to charge it (that call is the API's, and the
 *      API is what touches the Wallet Ledger inside a transaction);
 *   3. only if the gateway answers ok:true does it publish the GiftEvent and
 *      feed PKEngine.addPoints().
 *
 * A gift that fails the charge produces NO GiftEvent, NO PK points and NO
 * animation. There is no path in this package that can move a coin, which is
 * the whole point: the Room state is a projection, never the source of truth.
 *
 * The idempotencyKey travels from the client and is honoured by the gateway, so
 * a retried socket message can never double-charge (SPECs §27).
 */

export interface GiftChargeRequest {
  idempotencyKey: string;
  senderId: string;
  receiverId: string;
  giftId: string;
  quantity: number;
  /** Contextual only — the API stores it for the audit trail. */
  liveId: string;
  roomId: string;
}

export type GiftChargeFailure =
  | 'insufficient_funds'
  | 'unknown_gift'
  | 'invalid_quantity'
  | 'rejected'
  | 'unavailable';

export interface GiftChargeOk {
  ok: true;
  transactionId: string;
  coinsSpent: number;
  creatorPoints: number;
  pkPoints: number;
  /** Post-charge tier, so the room can refresh the badge without a DB read. */
  gifterLevel: number;
  /** True when the key was already settled — replay, do not re-broadcast. */
  replay: boolean;
}

export interface GiftChargeDenied {
  ok: false;
  reason: GiftChargeFailure;
  message: string;
}

export type GiftChargeResult = GiftChargeOk | GiftChargeDenied;

export interface EconomyGateway {
  chargeGift(req: GiftChargeRequest): Promise<GiftChargeResult>;
}

export const MAX_GIFT_QUANTITY = 999;

/**
 * Test/dev double. Deliberately mirrors the API's *contract*, not its storage:
 * balances live in a Map and vanish on restart. Never wire this in production —
 * defaultEconomyGateway() refuses to.
 */
export class InMemoryEconomyGateway implements EconomyGateway {
  private readonly balances = new Map<string, number>();
  private readonly gifterXp = new Map<string, number>();
  private readonly settled = new Map<string, GiftChargeOk>();
  /** Every charge, in order. Tests assert on this to prove single-settlement. */
  readonly ledger: Array<{ key: string; senderId: string; coins: number; at: number }> = [];

  constructor(private readonly defaultBalance = 1_000_000) {}

  credit(userId: string, coins: number): void {
    this.balances.set(userId, this.balanceOf(userId) + coins);
  }

  balanceOf(userId: string): number {
    const known = this.balances.get(userId);
    return known === undefined ? this.defaultBalance : known;
  }

  async chargeGift(req: GiftChargeRequest): Promise<GiftChargeResult> {
    const prior = this.settled.get(req.idempotencyKey);
    if (prior) return { ...prior, replay: true };

    const gift = GIFT_BY_ID.get(req.giftId);
    if (!gift || !gift.active) {
      return { ok: false, reason: 'unknown_gift', message: 'Presente indisponível' };
    }
    if (!Number.isInteger(req.quantity) || req.quantity < 1 || req.quantity > MAX_GIFT_QUANTITY) {
      return { ok: false, reason: 'invalid_quantity', message: 'Quantidade inválida' };
    }

    const cost = gift.coinCost * req.quantity;
    const balance = this.balanceOf(req.senderId);
    if (balance < cost) {
      return { ok: false, reason: 'insufficient_funds', message: 'Coins insuficientes' };
    }

    this.balances.set(req.senderId, balance - cost);
    const xp = (this.gifterXp.get(req.senderId) ?? 0) + cost;
    this.gifterXp.set(req.senderId, xp);

    const result: GiftChargeOk = {
      ok: true,
      transactionId: `tx_${this.ledger.length + 1}_${req.idempotencyKey}`,
      coinsSpent: cost,
      creatorPoints: gift.creatorPoints * req.quantity,
      pkPoints: gift.pkPoints * req.quantity,
      gifterLevel: tierFromXp(xp),
      replay: false,
    };
    this.settled.set(req.idempotencyKey, result);
    this.ledger.push({ key: req.idempotencyKey, senderId: req.senderId, coins: cost, at: Date.now() });
    return result;
  }
}

function tierFromXp(xp: number): number {
  // Kept local instead of importing GIFTER_TIERS logic twice; the API's answer
  // wins anyway, this stub only needs to be monotonic.
  const thresholds = [0, 500, 2_500, 12_000, 50_000, 200_000, 750_000];
  let level = 0;
  for (let i = 0; i < thresholds.length; i++) if (xp >= (thresholds[i] as number)) level = i;
  return level;
}

/**
 * Real gateway: one HTTP call into packages/api, which owns the transaction.
 *
 * TODO(api agent): confirm the route and the service-auth header. Until then
 * this class is unused unless API_BASE_URL is set, and any non-2xx answer is
 * treated as a denial — fail closed, so an API outage stops gifts instead of
 * handing them out for free.
 */
export class HttpEconomyGateway implements EconomyGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
    private readonly timeoutMs = 4_000,
  ) {}

  async chargeGift(req: GiftChargeRequest): Promise<GiftChargeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/internal/economy/gift`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${this.serviceToken}`,
          'idempotency-key': req.idempotencyKey,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        const reason: GiftChargeFailure = res.status === 402 ? 'insufficient_funds' : 'rejected';
        return { ok: false, reason, message: `Economia recusou (${res.status})` };
      }
      const body = (await res.json()) as Partial<GiftChargeOk>;
      if (!body || body.ok !== true || typeof body.transactionId !== 'string') {
        return { ok: false, reason: 'rejected', message: 'Resposta da economia inválida' };
      }
      return {
        ok: true,
        transactionId: body.transactionId,
        coinsSpent: body.coinsSpent ?? 0,
        creatorPoints: body.creatorPoints ?? 0,
        pkPoints: body.pkPoints ?? 0,
        gifterLevel: body.gifterLevel ?? 0,
        replay: body.replay === true,
      };
    } catch {
      return { ok: false, reason: 'unavailable', message: 'Economia indisponível' };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function defaultEconomyGateway(): EconomyGateway {
  if (config.apiBaseUrl) return new HttpEconomyGateway(config.apiBaseUrl, config.apiServiceToken);
  if (config.env === 'production') {
    throw new Error('API_BASE_URL is required in production — refusing to run gifts on the in-memory stub');
  }
  console.warn('[economy] API_BASE_URL vazio — usando InMemoryEconomyGateway (somente desenvolvimento).');
  return new InMemoryEconomyGateway();
}
