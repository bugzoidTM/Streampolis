import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';
import { config } from '../config.ts';
import { EconomyError } from '../economy/errors.ts';
import { purchaseCoins } from '../economy/EconomyService.ts';

/**
 * Checkout de Coins (PRD §14, §15, §30; SPECs §28, §62).
 *
 * O fluxo do MVP inteiro em uma linha: **dinheiro real → Coins → presente**.
 * Até aqui faltava a primeira seta — a carteira existia, o gift sabia gastar, e
 * não havia como uma conta nova ter um Coin sequer. Uma beta pública onde
 * ninguém consegue presentear não é uma beta de um jogo de presentes.
 *
 * ## Três regras que decidem o desenho
 *
 * 1. **Quem credita é o webhook, nunca o navegador.** `POST /me/checkout` só
 *    abre uma intenção de compra; a moeda entra quando o provedor confirma que
 *    o dinheiro entrou. Uma rota que o navegador alcançasse e creditasse seria
 *    uma impressora de Coins com um clique.
 * 2. **O preço é do banco.** O cliente escolhe o pacote pelo id; quanto custa e
 *    quantos Coins vêm junto são perguntas respondidas aqui — a mesma regra da
 *    loja (ver `Purchases.ts`).
 * 3. **A entrega é idempotente.** Gateways de pagamento reenviam o mesmo evento
 *    (é assim que eles garantem entrega), e o mesmo pagamento creditado duas
 *    vezes é dinheiro inventado. A dedupe acontece em dois níveis: a tabela
 *    `webhook_events` (provider, event_id) na porta, e a chave de idempotência
 *    do próprio pagamento no crédito.
 *
 * ## Provedor
 *
 * Não há gateway contratado. Em vez de fingir um, o provedor é uma
 * configuração (`PAYMENTS_PROVIDER`):
 *
 *   * `none` (padrão): `/me/checkout` responde 503 dizendo que a compra está
 *     indisponível. É a verdade, e é melhor do que uma tela de pagamento que
 *     não cobra nada;
 *   * `sandbox`: gera um pagamento pendente e uma URL de confirmação local. Só
 *     existe fora de produção — é o que permite o e2e comprar Coins de ponta a
 *     ponta sem cartão de crédito nenhum;
 *   * um gateway de verdade entra como um terceiro caso aqui e um adaptador
 *     que devolve `{ providerPaymentId, checkoutUrl }`. Nada mais do fluxo
 *     muda: o webhook e o crédito já estão prontos para ele.
 */

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'refunded';

export interface CoinPackage {
  id: string;
  name: string;
  coins: number;
  bonusCoins: number;
  /** O que o jogador recebe: `coins + bonusCoins`. Calculado aqui para a
   *  vitrine não ter que somar (e não ter como somar errado). */
  totalCoins: number;
  priceCents: number;
  currency: string;
}

export interface CheckoutIntent {
  paymentId: string;
  packageId: string;
  coins: number;
  priceCents: number;
  currency: string;
  status: PaymentStatus;
  checkoutUrl: string;
  provider: string;
  /**
   * PRD §15: tem de estar explícito que presentear não transfere dinheiro a
   * ninguém. O texto viaja com a intenção de compra porque é ali que a pessoa
   * está prestes a gastar — avisar depois é avisar tarde.
   */
  disclosure: string;
}

export const GIFT_DISCLOSURE =
  'Coins são um item virtual para uso dentro do Streampolis. Enviar um presente '
  + 'não transfere dinheiro para quem o recebe, e Coins não são resgatáveis, '
  + 'sacáveis nem transferíveis entre jogadores.';

interface PackageRow {
  id: string; name: string; coins: string | number; bonus_coins: string | number;
  price_cents: number; currency: string;
}

const toPackage = (r: PackageRow): CoinPackage => ({
  id: r.id,
  name: r.name,
  coins: Number(r.coins),
  bonusCoins: Number(r.bonus_coins),
  totalCoins: Number(r.coins) + Number(r.bonus_coins),
  priceCents: r.price_cents,
  currency: r.currency,
});

export async function listCoinPackages(): Promise<CoinPackage[]> {
  const { rows } = await pool.query<PackageRow>(
    `SELECT id, name, coins, bonus_coins, price_cents, currency
       FROM coin_packages WHERE active ORDER BY sort_order, price_cents`,
  );
  return rows.map(toPackage);
}

/** Quantos pagamentos pendentes uma conta pode ter abertos ao mesmo tempo.
 *  Sem teto, um laço no navegador enche a tabela de pagamentos que ninguém vai
 *  pagar — e a lista de "suas compras" vira lixo para o próprio jogador. */
const MAX_PENDENTES = 5;

export async function startCheckout(input: { userId: string; packageId: string }): Promise<CheckoutIntent> {
  if (config.payments.provider === 'none') {
    throw new EconomyError('PAYMENTS_UNAVAILABLE',
      'A compra de Coins ainda não está disponível.', 503);
  }

  const { rows } = await pool.query<PackageRow>(
    `SELECT id, name, coins, bonus_coins, price_cents, currency
       FROM coin_packages WHERE id = $1 AND active`,
    [input.packageId],
  );
  const pacote = rows[0] && toPackage(rows[0]);
  if (!pacote) throw new EconomyError('PACKAGE_UNKNOWN', 'Pacote indisponível.', 404);

  const { rows: pendentes } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM payments WHERE user_id = $1 AND status = 'pending'`,
    [input.userId],
  );
  if (Number(pendentes[0].n) >= MAX_PENDENTES) {
    throw new EconomyError('TOO_MANY_PENDING',
      'Você tem compras aguardando pagamento. Conclua ou cancele uma antes de abrir outra.', 429);
  }

  const paymentId = randomUUID();
  const providerPaymentId = `${config.payments.provider}_${paymentId}`;
  const checkoutUrl = `${config.payments.returnUrl}/checkout/${paymentId}`;

  await pool.query(
    `INSERT INTO payments
       (id, user_id, provider, provider_payment_id, package_id, coins, amount_cents, currency, status, checkout_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)`,
    [paymentId, input.userId, config.payments.provider, providerPaymentId, pacote.id,
      pacote.totalCoins, pacote.priceCents, pacote.currency, checkoutUrl],
  );

  return {
    paymentId,
    packageId: pacote.id,
    coins: pacote.totalCoins,
    priceCents: pacote.priceCents,
    currency: pacote.currency,
    status: 'pending',
    checkoutUrl,
    provider: config.payments.provider,
    disclosure: GIFT_DISCLOSURE,
  };
}

export interface PaymentSummary {
  paymentId: string;
  packageId: string;
  coins: number;
  priceCents: number;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  paidAt: string | null;
}

export async function listPayments(userId: string, limit = 20): Promise<PaymentSummary[]> {
  const { rows } = await pool.query(
    `SELECT id, package_id, coins, amount_cents, currency, status, created_at, paid_at
       FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map((r) => ({
    paymentId: r.id,
    packageId: r.package_id,
    coins: Number(r.coins),
    priceCents: r.amount_cents,
    currency: r.currency,
    status: r.status as PaymentStatus,
    createdAt: r.created_at.toISOString(),
    paidAt: r.paid_at ? r.paid_at.toISOString() : null,
  }));
}

/**
 * Confere a assinatura do webhook em tempo constante.
 *
 * O corpo CRU é o que assina — reserializar o JSON mudaria um espaço e
 * derrubaria a assinatura de um gateway honesto. Comparação em tempo constante
 * porque comparar strings com `===` vaza, byte a byte, quanto do prefixo estava
 * certo: é assim que se forja uma assinatura sem conhecer o segredo.
 */
export function signatureMatches(rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature) return false;
  const esperado = createHmac('sha256', config.webhookSecret).update(rawBody).digest('hex');
  const recebido = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(recebido, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface WebhookInput {
  provider: string;
  eventId: string;
  eventType: string;
  paymentId: string;
  payload: unknown;
  signature?: string;
}

export type WebhookOutcome =
  | { result: 'credited'; paymentId: string; coins: number }
  | { result: 'duplicate'; paymentId: string }
  | { result: 'ignored'; reason: string };

/**
 * Processa um evento do provedor.
 *
 * A ordem importa e é esta: registrar o evento (que é o que torna o reenvio
 * inofensivo), travar o pagamento, creditar, e só então marcar como pago. O
 * schema não deixa ser diferente — `payment_paid_has_credit` recusa um
 * pagamento "pago" sem transação de crédito, ou seja, Coins prometidos e não
 * entregues são impossíveis de gravar.
 */
export async function handlePaymentWebhook(input: WebhookInput): Promise<WebhookOutcome> {
  // Porta de entrada: o mesmo event_id nunca é processado duas vezes (SPECs §62).
  const { rowCount } = await pool.query(
    `INSERT INTO webhook_events (provider, event_id, event_type, payload, signature)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider, event_id) DO NOTHING`,
    [input.provider, input.eventId, input.eventType, JSON.stringify(input.payload ?? {}),
      input.signature ?? null],
  );
  if (rowCount === 0) return { result: 'duplicate', paymentId: input.paymentId };

  const marcaProcessado = (result: string) => pool.query(
    `UPDATE webhook_events SET processed_at = now(), result = $3
      WHERE provider = $1 AND event_id = $2`,
    [input.provider, input.eventId, result],
  );

  if (input.eventType !== 'payment.paid') {
    // `payment.failed`/`canceled` fecham a intenção; qualquer outro tipo é
    // registrado e ignorado — um gateway manda muito mais eventos do que um
    // jogo precisa ouvir.
    const novoStatus = input.eventType === 'payment.failed' ? 'failed'
      : input.eventType === 'payment.canceled' ? 'canceled' : null;
    if (novoStatus) {
      await pool.query(
        `UPDATE payments SET status = $2 WHERE id = $1 AND status = 'pending'`,
        [input.paymentId, novoStatus],
      );
    }
    await marcaProcessado(novoStatus ?? 'ignored');
    return { result: 'ignored', reason: input.eventType };
  }

  const pagamento = await withTransaction(async (client) => {
    // FOR UPDATE: duas entregas simultâneas do mesmo evento (ids diferentes,
    // mesmo pagamento) não podem creditar em paralelo.
    const { rows } = await client.query(
      `SELECT id, user_id, coins, status FROM payments WHERE id = $1 FOR UPDATE`,
      [input.paymentId],
    );
    return rows[0] ?? null;
  });

  if (!pagamento) {
    await marcaProcessado('unknown_payment');
    return { result: 'ignored', reason: 'unknown_payment' };
  }
  if (pagamento.status === 'paid') {
    await marcaProcessado('already_paid');
    return { result: 'duplicate', paymentId: input.paymentId };
  }
  if (pagamento.status !== 'pending') {
    await marcaProcessado(`status_${pagamento.status}`);
    return { result: 'ignored', reason: `status_${pagamento.status}` };
  }

  const coins = Number(pagamento.coins);
  const credito = await purchaseCoins({
    userId: pagamento.user_id,
    coins,
    paymentId: input.paymentId,
    // A chave é o PAGAMENTO, não o evento: dois eventos diferentes para a mesma
    // compra continuam creditando uma vez só.
    idempotencyKey: `payment_${input.paymentId}`,
  });

  await pool.query(
    `UPDATE payments SET status = 'paid', paid_at = now(), credit_tx_id = $2 WHERE id = $1`,
    [input.paymentId, credito.transaction.id],
  );
  await marcaProcessado('credited');
  return { result: 'credited', paymentId: input.paymentId, coins };
}

/**
 * Confirmação do provedor `sandbox`: o que um gateway de verdade faria depois
 * do cartão passar. Existe para o e2e conseguir comprar Coins de ponta a ponta,
 * e por isso **não roda em produção** — quem decide isso é a configuração, não
 * este arquivo (ver `config.payments`).
 */
export async function sandboxConfirm(paymentId: string, userId: string): Promise<WebhookOutcome> {
  if (config.payments.provider !== 'sandbox') {
    throw new EconomyError('SANDBOX_DISABLED', 'Confirmação de sandbox indisponível.', 404);
  }
  // Confirmar é creditar, e creditar é sempre para o dono do pagamento. Sem
  // esta conferência, qualquer sessão poderia fechar a compra de outra pessoa —
  // inofensivo no sandbox, mas é a forma do código que vira o provedor de
  // verdade amanhã.
  const { rows } = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM payments WHERE id = $1', [paymentId],
  );
  if (!rows[0] || rows[0].user_id !== userId) {
    throw new EconomyError('SANDBOX_DISABLED', 'Pagamento não encontrado.', 404);
  }
  const payload = { id: `sbx_${paymentId}`, type: 'payment.paid', paymentId };
  return handlePaymentWebhook({
    provider: 'sandbox',
    eventId: `sbx_${paymentId}`,
    eventType: 'payment.paid',
    paymentId,
    payload,
  });
}
