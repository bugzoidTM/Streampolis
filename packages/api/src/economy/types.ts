export type Currency = 'coins' | 'credits';

export type TransactionType =
  | 'purchase'
  | 'grant'
  | 'spend'
  | 'gift'
  | 'refund'
  | 'admin_adjustment';

export interface LedgerEntry {
  id: string;
  userId: string;
  currency: Currency;
  type: TransactionType;
  /** Assinado: negativo debita, positivo credita. */
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  actorId: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface Balances {
  coins: number;
  credits: number;
}

/** Resultado de qualquer operação monetária. `replayed` = idempotência agiu. */
export interface EconomyResult {
  transaction: LedgerEntry;
  balances: Balances;
  replayed: boolean;
}

export interface GiftResult extends EconomyResult {
  giftEventId: string;
  giftId: string;
  quantity: number;
  coinTotal: number;
  creatorPoints: number;
  pkPoints: number;
  receiverId: string;
  liveId: string | null;
}
