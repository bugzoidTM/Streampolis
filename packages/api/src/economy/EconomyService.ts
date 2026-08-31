/**
 * Economy Service (SPECs §25, §26, §27; PRD §29).
 *
 * Invariantes que este arquivo existe para garantir:
 *  1. Toda operação roda numa transação Postgres com SELECT ... FOR UPDATE na
 *     carteira. Nada de "ler saldo, decidir, escrever" fora de lock.
 *  2. Todo movimento grava uma linha imutável em wallet_transactions com saldo
 *     anterior e posterior.
 *  3. Toda operação carrega idempotency_key com índice único: a mesma chave
 *     duas vezes produz UMA transação.
 *  4. O cliente nunca informa saldo nem preço. Preço vem do catálogo no banco.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from '../db/pool.ts';
import { pool } from '../db/pool.ts';
import { withTransaction, isUniqueViolation } from '../db/tx.ts';
import { EconomyError } from './errors.ts';
import type {
  Balances,
  Currency,
  EconomyResult,
  GiftResult,
  LedgerEntry,
  TransactionType,
} from './types.ts';

interface LedgerRow {
  id: string;
  user_id: string;
  currency: Currency;
  type: TransactionType;
  amount: number;
  balance_before: number;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  idempotency_key: string;
  actor_id: string | null;
  reason: string | null;
  created_at: Date;
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    userId: row.user_id,
    currency: row.currency,
    type: row.type,
    amount: row.amount,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    idempotencyKey: row.idempotency_key,
    actorId: row.actor_id,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

const BALANCE_COLUMN: Record<Currency, 'coins_balance' | 'credits_balance'> = {
  coins: 'coins_balance',
  credits: 'credits_balance',
};

interface LockedWallet {
  coins: number;
  credits: number;
}

/**
 * Cria a carteira se faltar e trava a linha. Este é o ponto de serialização de
 * toda a economia: duas operações do mesmo usuário nunca leem o mesmo saldo.
 */
async function lockWallet(client: PoolClient, userId: string): Promise<LockedWallet> {
  const user = await client.query<{ status: string; economy_blocked: boolean }>(
    'SELECT status, economy_blocked FROM users WHERE id = $1',
    [userId],
  );
  if (user.rowCount === 0) {
    throw new EconomyError('USER_NOT_FOUND', 'Usuário inexistente.', 404);
  }
  if (user.rows[0].economy_blocked || user.rows[0].status === 'banned') {
    throw new EconomyError('ECONOMY_BLOCKED', 'Economia bloqueada para esta conta.', 403);
  }

  await client.query(
    'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
  const { rows } = await client.query<{ coins_balance: number; credits_balance: number }>(
    'SELECT coins_balance, credits_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return { coins: rows[0].coins_balance, credits: rows[0].credits_balance };
}

async function findByIdempotencyKey(
  client: Pick<PoolClient, 'query'>,
  key: string,
): Promise<LedgerEntry | null> {
  const { rows } = await client.query<LedgerRow>(
    'SELECT * FROM wallet_transactions WHERE idempotency_key = $1',
    [key],
  );
  return rows.length > 0 ? toEntry(rows[0]) : null;
}

async function readBalances(
  client: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<Balances> {
  const { rows } = await client.query<{ coins_balance: number; credits_balance: number }>(
    'SELECT coins_balance, credits_balance FROM wallets WHERE user_id = $1',
    [userId],
  );
  if (rows.length === 0) return { coins: 0, credits: 0 };
  return { coins: rows[0].coins_balance, credits: rows[0].credits_balance };
}

interface MovementInput {
  userId: string;
  currency: Currency;
  type: TransactionType;
  /** Assinado. Negativo debita. */
  amount: number;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey: string;
  actorId?: string | null;
  reason?: string | null;
  /** Saldo já travado por quem chamou, para não travar duas vezes. */
  locked?: LockedWallet;
}

/**
 * Núcleo do ledger. Só é chamado de dentro de uma transação já aberta.
 * Não valida regra de negócio — valida dinheiro.
 */
async function applyMovement(
  client: PoolClient,
  input: MovementInput,
): Promise<LedgerEntry> {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new EconomyError('INVALID_AMOUNT', 'Valor inválido.', 400);
  }

  const wallet = input.locked ?? (await lockWallet(client, input.userId));
  const before = input.currency === 'coins' ? wallet.coins : wallet.credits;
  const after = before + input.amount;

  if (after < 0) {
    throw new EconomyError(
      'INSUFFICIENT_FUNDS',
      'Saldo insuficiente para concluir a operação.',
      402,
    );
  }

  await client.query(
    `UPDATE wallets SET ${BALANCE_COLUMN[input.currency]} = $2, updated_at = now()
       WHERE user_id = $1`,
    [input.userId, after],
  );

  const { rows } = await client.query<LedgerRow>(
    `INSERT INTO wallet_transactions
       (user_id, currency, type, amount, balance_before, balance_after,
        reference_type, reference_id, idempotency_key, actor_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      input.userId,
      input.currency,
      input.type,
      input.amount,
      before,
      after,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.idempotencyKey,
      input.actorId ?? null,
      input.reason ?? null,
    ],
  );

  // Mantém o saldo em memória coerente para um segundo movimento na mesma tx.
  if (input.currency === 'coins') wallet.coins = after;
  else wallet.credits = after;

  return toEntry(rows[0]);
}

/**
 * Executa `run` em transação, com o guarda de idempotência. Se a chave já
 * existe, devolve o resultado antigo sem tocar em saldo.
 */
async function idempotentOperation<T extends EconomyResult>(
  idempotencyKey: string,
  userId: string,
  run: (client: PoolClient, wallet: LockedWallet) => Promise<T>,
  replay: (client: PoolClient, existing: LedgerEntry) => Promise<T>,
): Promise<T> {
  try {
    return await withTransaction(async (client) => {
      // O lock da carteira vem ANTES da checagem: duas entregas concorrentes da
      // mesma chave serializam aqui, e a segunda enxerga a primeira já gravada.
      const wallet = await lockWallet(client, userId);
      const existing = await findByIdempotencyKey(client, idempotencyKey);
      if (existing !== null) return replay(client, existing);
      return run(client, wallet);
    });
  } catch (err) {
    // Rede de segurança: chaves do mesmo usuário serializam no lock acima, mas o
    // índice único é a garantia final (ex.: chave reaproveitada entre usuários).
    if (isUniqueViolation(err, 'wallet_transactions_idempotency_key')) {
      const existing = await findByIdempotencyKey(pool, idempotencyKey);
      if (existing !== null) {
        return withTransaction((client) => replay(client, existing));
      }
    }
    throw err;
  }
}

async function replayPlain(
  client: PoolClient,
  existing: LedgerEntry,
): Promise<EconomyResult> {
  return {
    transaction: existing,
    balances: await readBalances(client, existing.userId),
    replayed: true,
  };
}

// --------------------------------------------------------------------------
// API pública
// --------------------------------------------------------------------------

export async function getBalances(userId: string): Promise<Balances> {
  return readBalances(pool, userId);
}

export async function ensureWallet(
  client: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<void> {
  await client.query(
    'INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

export interface PurchaseCoinsInput {
  userId: string;
  coins: number;
  paymentId: string;
  idempotencyKey: string;
}

/**
 * Credita Coins comprados. SÓ deve ser chamado pelo processamento de webhook
 * validado (§28) — nunca por uma rota que o navegador alcance.
 */
export async function purchaseCoins(input: PurchaseCoinsInput): Promise<EconomyResult> {
  if (!Number.isSafeInteger(input.coins) || input.coins <= 0) {
    throw new EconomyError('INVALID_AMOUNT', 'Quantidade de Coins inválida.', 400);
  }
  return idempotentOperation<EconomyResult>(
    input.idempotencyKey,
    input.userId,
    async (client, wallet) => {
      const tx = await applyMovement(client, {
        userId: input.userId,
        currency: 'coins',
        type: 'purchase',
        amount: input.coins,
        referenceType: 'payment',
        referenceId: input.paymentId,
        idempotencyKey: input.idempotencyKey,
        locked: wallet,
      });
      return { transaction: tx, balances: await readBalances(client, input.userId), replayed: false };
    },
    replayPlain,
  );
}

export interface SpendInput {
  userId: string;
  amount: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  reason?: string;
  /**
   * Efeito que precisa acontecer NA MESMA transação do débito — entregar o
   * item comprado, por exemplo. Fora da transação, uma queda entre debitar e
   * entregar deixa o jogador sem a moeda e sem a peça, e isso vira suporte.
   * Não roda no replay: a chave repetida já entregou na primeira vez.
   */
  onSpent?: (client: PoolClient) => Promise<void>;
}

export async function spendCoins(input: SpendInput): Promise<EconomyResult> {
  return spend(input, 'coins');
}

export async function spendCredits(input: SpendInput): Promise<EconomyResult> {
  return spend(input, 'credits');
}

async function spend(input: SpendInput, currency: Currency): Promise<EconomyResult> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new EconomyError('INVALID_AMOUNT', 'Valor deve ser inteiro positivo.', 400);
  }
  return idempotentOperation<EconomyResult>(
    input.idempotencyKey,
    input.userId,
    async (client, wallet) => {
      const tx = await applyMovement(client, {
        userId: input.userId,
        currency,
        type: 'spend',
        amount: -input.amount,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason ?? null,
        locked: wallet,
      });
      await input.onSpent?.(client);
      return { transaction: tx, balances: await readBalances(client, input.userId), replayed: false };
    },
    replayPlain,
  );
}

export interface GrantInput {
  userId: string;
  amount: number;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
}

/** Credits são conquistados jogando (PRD §14); nunca comprados por aqui. */
export async function grantCredits(input: GrantInput): Promise<EconomyResult> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new EconomyError('INVALID_AMOUNT', 'Valor deve ser inteiro positivo.', 400);
  }
  return idempotentOperation<EconomyResult>(
    input.idempotencyKey,
    input.userId,
    async (client, wallet) => {
      const tx = await applyMovement(client, {
        userId: input.userId,
        currency: 'credits',
        type: 'grant',
        amount: input.amount,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        idempotencyKey: input.idempotencyKey,
        locked: wallet,
      });
      return { transaction: tx, balances: await readBalances(client, input.userId), replayed: false };
    },
    replayPlain,
  );
}

export interface SendGiftInput {
  senderId: string;
  receiverId: string;
  giftId: string;
  quantity: number;
  liveId?: string | null;
  idempotencyKey: string;
}

/**
 * NÃO existe entrada de PK aqui, de propósito.
 *
 * O placar de uma batalha é do Game Server (SPECs §33): ele tem o relógio, as
 * fases e a ordem dos eventos. Se a API também somasse pontos dentro da
 * transação do débito, existiriam duas autoridades para o mesmo número e a
 * primeira divergência de rede decidiria um PK. A API guarda o RESULTADO que o
 * servidor apurou — ver src/pk/PkRecords.ts — e o `pk_points` gravado em
 * gift_events é o valor do presente, não um voto no placar.
 */

/**
 * §26. Fluxo: lock wallet → valida saldo → debita → ledger → gift_event →
 * Creator Points → COMMIT. O preço vem do gift_catalog; o cliente só diz QUAL
 * presente e quantos.
 */
export async function sendGift(input: SendGiftInput): Promise<GiftResult> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > 999) {
    throw new EconomyError('INVALID_AMOUNT', 'Quantidade inválida.', 400);
  }
  if (input.senderId === input.receiverId) {
    throw new EconomyError('SELF_GIFT', 'Não é possível presentear a si mesmo.', 400);
  }

  return idempotentOperation<GiftResult>(
    input.idempotencyKey,
    input.senderId,
    async (client, wallet) => {
      const gift = await client.query<{
        coin_cost: number;
        creator_points: number;
        pk_points: number;
        active: boolean;
      }>(
        'SELECT coin_cost, creator_points, pk_points, active FROM gift_catalog WHERE id = $1',
        [input.giftId],
      );
      if (gift.rowCount === 0) {
        throw new EconomyError('GIFT_NOT_FOUND', 'Presente inexistente.', 404);
      }
      if (!gift.rows[0].active) {
        throw new EconomyError('GIFT_INACTIVE', 'Presente indisponível.', 409);
      }

      const receiver = await client.query('SELECT 1 FROM users WHERE id = $1 AND status = $2', [
        input.receiverId,
        'active',
      ]);
      if (receiver.rowCount === 0) {
        throw new EconomyError('USER_NOT_FOUND', 'Destinatário indisponível.', 404);
      }

      const coinTotal = gift.rows[0].coin_cost * input.quantity;
      const creatorPoints = gift.rows[0].creator_points * input.quantity;
      const pkPoints = gift.rows[0].pk_points * input.quantity;

      // O id do gift event é gerado antes para virar reference_id do ledger: a
      // linha do ledger é imutável, então não dá para preenchê-la depois.
      const giftEventId = randomUUID();

      const tx = await applyMovement(client, {
        userId: input.senderId,
        currency: 'coins',
        type: 'gift',
        amount: -coinTotal,
        referenceType: 'gift_event',
        referenceId: giftEventId,
        idempotencyKey: input.idempotencyKey,
        locked: wallet,
      });

      await client.query(
        `INSERT INTO gift_events
           (id, sender_id, receiver_id, live_id, gift_id, quantity, coin_total,
            creator_points, pk_points, transaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          giftEventId,
          input.senderId,
          input.receiverId,
          input.liveId ?? null,
          input.giftId,
          input.quantity,
          coinTotal,
          creatorPoints,
          pkPoints,
          tx.id,
        ],
      );

      // Trava as duas linhas de stats em ordem de id: sem ordem fixa, dois
      // usuários se presenteando ao mesmo tempo dariam deadlock.
      await client.query(
        'SELECT user_id FROM player_stats WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE',
        [[input.senderId, input.receiverId]],
      );
      await client.query(
        `UPDATE player_stats
            SET creator_points = creator_points + $2,
                fame = fame + $3,
                updated_at = now()
          WHERE user_id = $1`,
        [input.receiverId, creatorPoints, Math.floor(creatorPoints / 10)],
      );
      await client.query(
        `UPDATE player_stats
            SET gifter_xp = gifter_xp + $2,
                gifter_level = GREATEST(gifter_level, 1 + floor(sqrt((gifter_xp + $2) / 100.0))::int),
                updated_at = now()
          WHERE user_id = $1`,
        [input.senderId, coinTotal],
      );

      if (input.liveId != null) {
        await client.query(
          'UPDATE stream_sessions SET gift_coin_total = gift_coin_total + $2 WHERE id = $1',
          [input.liveId, coinTotal],
        );
      }

      return {
        transaction: tx,
        balances: await readBalances(client, input.senderId),
        replayed: false,
        giftEventId,
        giftId: input.giftId,
        quantity: input.quantity,
        coinTotal,
        creatorPoints,
        pkPoints,
        receiverId: input.receiverId,
        liveId: input.liveId ?? null,
      };
    },
    async (client, existing) => {
      const { rows } = await client.query<{
        id: string;
        gift_id: string;
        quantity: number;
        coin_total: number;
        creator_points: number;
        pk_points: number;
        receiver_id: string;
        live_id: string | null;
      }>('SELECT * FROM gift_events WHERE transaction_id = $1', [existing.id]);
      if (rows.length === 0) {
        throw new EconomyError(
          'IDEMPOTENCY_CONFLICT',
          'Chave de idempotência já usada por outra operação.',
          409,
        );
      }
      const g = rows[0];
      return {
        transaction: existing,
        balances: await readBalances(client, existing.userId),
        replayed: true,
        giftEventId: g.id,
        giftId: g.gift_id,
        quantity: g.quantity,
        coinTotal: g.coin_total,
        creatorPoints: g.creator_points,
        pkPoints: g.pk_points,
        receiverId: g.receiver_id,
        liveId: g.live_id,
      };
    },
  );
}

export interface RefundInput {
  transactionId: string;
  adminId: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * Estorna uma transação: lança o inverso exato dela. Estornar uma compra DEBITA
 * Coins — se o usuário já gastou, o estorno é recusado por saldo insuficiente
 * (saldo negativo não existe neste ledger; o caminho é adminAdjustment auditado).
 */
export async function refundTransaction(input: RefundInput): Promise<EconomyResult> {
  if (input.reason.trim().length < 3) {
    throw new EconomyError('REASON_REQUIRED', 'Motivo do estorno é obrigatório.', 400);
  }

  const original = await pool.query<LedgerRow>(
    'SELECT * FROM wallet_transactions WHERE id = $1',
    [input.transactionId],
  );
  if (original.rowCount === 0) {
    throw new EconomyError('TRANSACTION_NOT_FOUND', 'Transação inexistente.', 404);
  }
  const source = toEntry(original.rows[0]);
  if (source.type === 'refund') {
    throw new EconomyError('ALREADY_REFUNDED', 'Não se estorna um estorno.', 409);
  }

  return idempotentOperation<EconomyResult>(
    input.idempotencyKey,
    source.userId,
    async (client, wallet) => {
      const already = await client.query(
        `SELECT 1 FROM wallet_transactions
          WHERE type = 'refund' AND reference_type = 'refund_of' AND reference_id = $1`,
        [source.id],
      );
      if ((already.rowCount ?? 0) > 0) {
        throw new EconomyError('ALREADY_REFUNDED', 'Transação já estornada.', 409);
      }
      const tx = await applyMovement(client, {
        userId: source.userId,
        currency: source.currency,
        type: 'refund',
        amount: -source.amount,
        referenceType: 'refund_of',
        referenceId: source.id,
        idempotencyKey: input.idempotencyKey,
        actorId: input.adminId,
        reason: input.reason.trim(),
        locked: wallet,
      });
      return { transaction: tx, balances: await readBalances(client, source.userId), replayed: false };
    },
    replayPlain,
  );
}

export interface AdminAdjustmentInput {
  adminId: string;
  userId: string;
  currency: Currency;
  /** Assinado: positivo credita, negativo debita. */
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/**
 * §65: nenhum administrador altera saldo sem registro. adminId, motivo e
 * timestamp são obrigatórios — o CHECK do banco recusa mesmo se a aplicação
 * esquecer.
 */
export async function adminAdjustment(
  input: AdminAdjustmentInput,
): Promise<EconomyResult> {
  if (typeof input.adminId !== 'string' || input.adminId.length === 0) {
    throw new EconomyError('REASON_REQUIRED', 'adminId é obrigatório.', 400);
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3) {
    throw new EconomyError('REASON_REQUIRED', 'Motivo do ajuste é obrigatório.', 400);
  }
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    throw new EconomyError('INVALID_AMOUNT', 'Valor do ajuste inválido.', 400);
  }

  return idempotentOperation<EconomyResult>(
    input.idempotencyKey,
    input.userId,
    async (client, wallet) => {
      const tx = await applyMovement(client, {
        userId: input.userId,
        currency: input.currency,
        type: 'admin_adjustment',
        amount: input.amount,
        referenceType: 'admin',
        referenceId: input.adminId,
        idempotencyKey: input.idempotencyKey,
        actorId: input.adminId,
        reason: input.reason.trim(),
        locked: wallet,
      });
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, reason, metadata)
         VALUES ($1, 'admin', 'economy.admin_adjustment', 'user', $2, $3, $4::jsonb)`,
        [
          input.adminId,
          input.userId,
          input.reason.trim(),
          JSON.stringify({
            currency: input.currency,
            amount: input.amount,
            transactionId: tx.id,
            balanceBefore: tx.balanceBefore,
            balanceAfter: tx.balanceAfter,
          }),
        ],
      );
      return { transaction: tx, balances: await readBalances(client, input.userId), replayed: false };
    },
    replayPlain,
  );
}

export interface LedgerPage {
  entries: LedgerEntry[];
  nextCursor: string | null;
}

export async function listTransactions(
  userId: string,
  limit = 50,
  before?: string,
): Promise<LedgerPage> {
  const capped = Math.min(Math.max(limit, 1), 100);
  const { rows } = await pool.query<LedgerRow>(
    `SELECT * FROM wallet_transactions
      WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2::timestamptz)
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [userId, before ?? null, capped + 1],
  );
  const entries = rows.slice(0, capped).map(toEntry);
  const nextCursor =
    rows.length > capped ? entries[entries.length - 1].createdAt.toISOString() : null;
  return { entries, nextCursor };
}
