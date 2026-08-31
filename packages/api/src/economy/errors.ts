export type EconomyErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_AMOUNT'
  | 'USER_NOT_FOUND'
  | 'ECONOMY_BLOCKED'
  | 'GIFT_NOT_FOUND'
  | 'GIFT_INACTIVE'
  | 'SELF_GIFT'
  | 'REASON_REQUIRED'
  | 'TRANSACTION_NOT_FOUND'
  | 'ALREADY_REFUNDED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ITEM_NOT_OWNED'
  | 'ITEM_UNKNOWN'
  | 'ITEM_INACTIVE'
  | 'WRONG_CURRENCY'
  | 'PK_NOT_ACTIVE'
  | 'PK_ALREADY_FINISHED'
  | 'FEATURE_DISABLED';

/** Erro de regra de economia. Nunca carrega saldo em mensagem para o cliente. */
export class EconomyError extends Error {
  readonly code: EconomyErrorCode;
  readonly httpStatus: number;

  constructor(code: EconomyErrorCode, message: string, httpStatus = 409) {
    super(message);
    this.name = 'EconomyError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
