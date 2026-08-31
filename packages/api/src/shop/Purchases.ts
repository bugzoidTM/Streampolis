import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.ts';
import { EconomyError } from '../economy/errors.ts';
import { getBalances, spendCoins, spendCredits } from '../economy/EconomyService.ts';
import type { Balances, Currency } from '../economy/types.ts';

/**
 * Loja (PRD §13, §16; SPECs §25, §27).
 *
 * A regra que este arquivo existe para garantir: **o preço é do banco**. O
 * navegador diz o que quer comprar e com qual moeda; quanto custa, se está
 * ativo e se já é dele são perguntas respondidas aqui. Um cliente que pudesse
 * informar o preço compraria a Coroa por 1 Coin.
 *
 * A entrega acontece dentro da MESMA transação do débito (`onSpent`): moeda
 * saindo sem item entrando é o defeito que gera suporte e estorno manual.
 */

export interface PurchaseInput {
  userId: string;
  itemId: string;
  currency: Currency;
  /** Exigida: sem ela um duplo-clique compra duas vezes (SPECs §27). */
  idempotencyKey: string;
}

export interface PurchaseResult {
  itemId: string;
  currency: Currency;
  price: number;
  balances: Balances;
  /** A chave já tinha sido usada; nada foi cobrado de novo. */
  replayed: boolean;
  /** Já era do jogador antes desta chamada; nada foi cobrado. */
  alreadyOwned: boolean;
}

interface ItemRow {
  id: string;
  type: string;
  name: string;
  credits_price: number | null;
  coins_price: number | null;
  active: boolean;
}

export async function listInventory(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ item_id: string }>(
    'SELECT item_id FROM inventory WHERE user_id = $1 AND quantity > 0',
    [userId],
  );
  return rows.map((r) => r.item_id);
}

export async function purchaseItem(input: PurchaseInput): Promise<PurchaseResult> {
  const { rows } = await pool.query<ItemRow>(
    'SELECT id, type, name, credits_price, coins_price, active FROM items WHERE id = $1',
    [input.itemId],
  );
  const item = rows[0];
  if (!item) throw new EconomyError('ITEM_UNKNOWN', 'Item inexistente.', 404);
  if (!item.active) throw new EconomyError('ITEM_INACTIVE', 'Item fora de catálogo.', 409);

  const price = input.currency === 'coins' ? item.coins_price : item.credits_price;
  if (price === null) {
    throw new EconomyError(
      'WRONG_CURRENCY',
      input.currency === 'coins'
        ? 'Este item não é vendido por Coins.'
        : 'Este item não é vendido por Credits.',
      400,
    );
  }

  const owned = await pool.query(
    'SELECT 1 FROM inventory WHERE user_id = $1 AND item_id = $2 AND quantity > 0',
    [input.userId, input.itemId],
  );
  if ((owned.rowCount ?? 0) > 0) {
    // Já é dele. Não é erro — é o segundo clique, ou a mesma peça vindo de uma
    // recompensa. Cobrar de novo seria roubo silencioso.
    return {
      itemId: item.id,
      currency: input.currency,
      price,
      balances: await getBalances(input.userId),
      replayed: false,
      alreadyOwned: true,
    };
  }

  // Item gratuito não movimenta carteira: uma linha de ledger com valor zero é
  // proibida pelo próprio banco (amount <> 0).
  if (price === 0) {
    await grantItem(input.userId, item.id);
    return {
      itemId: item.id,
      currency: input.currency,
      price: 0,
      balances: await getBalances(input.userId),
      replayed: false,
      alreadyOwned: false,
    };
  }

  const spend = input.currency === 'coins' ? spendCoins : spendCredits;
  const result = await spend({
    userId: input.userId,
    amount: price,
    referenceType: 'item',
    referenceId: item.id,
    idempotencyKey: input.idempotencyKey,
    reason: `Compra: ${item.name}`,
    onSpent: async (client) => {
      await client.query(
        `INSERT INTO inventory (user_id, item_id, quantity)
         VALUES ($1, $2, 1)
         ON CONFLICT (user_id, item_id) DO UPDATE SET quantity = inventory.quantity + 1`,
        [input.userId, item.id],
      );
    },
  });

  return {
    itemId: item.id,
    currency: input.currency,
    price,
    balances: result.balances,
    replayed: result.replayed,
    alreadyOwned: false,
  };
}

/** Entrega sem cobrança: itens grátis e recompensas. */
export async function grantItem(userId: string, itemId: string): Promise<void> {
  await pool.query(
    `INSERT INTO inventory (user_id, item_id, quantity)
     VALUES ($1, $2, 1)
     ON CONFLICT (user_id, item_id) DO NOTHING`,
    [userId, itemId],
  );
}

/** Chave de idempotência para a UI, quando ela não tiver uma própria. */
export function newPurchaseKey(): string {
  return `shop_${randomUUID()}`;
}
