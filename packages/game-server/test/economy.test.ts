import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryEconomyGateway, MAX_GIFT_QUANTITY } from '../src/economy/EconomyGateway.js';
import { GIFT_BY_ID } from '../src/shared.js';

const ROSE = GIFT_BY_ID.get('g_rose')!;
const DIAMOND = GIFT_BY_ID.get('g_diamond')!;

function req(over: Partial<Parameters<InMemoryEconomyGateway['chargeGift']>[0]> = {}) {
  return {
    idempotencyKey: 'key_1',
    senderId: 'sender',
    receiverId: 'host',
    giftId: ROSE.id,
    quantity: 1,
    liveId: 'live_1',
    roomId: 'room_1',
    ...over,
  };
}

describe('EconomyGateway (stub em memória)', () => {
  it('cobra uma vez só para a mesma chave de idempotência', async () => {
    const gw = new InMemoryEconomyGateway(100);
    const first = await gw.chargeGift(req({ giftId: DIAMOND.id }));
    assert.equal(first.ok, false, 'saldo 100 não paga um diamante de 499');

    const gw2 = new InMemoryEconomyGateway(1_000);
    const a = await gw2.chargeGift(req({ giftId: DIAMOND.id }));
    const b = await gw2.chargeGift(req({ giftId: DIAMOND.id }));
    assert.ok(a.ok && b.ok);
    assert.equal(a.replay, false);
    assert.equal(b.replay, true, 'a segunda entrega da mesma mensagem é replay');
    assert.equal(gw2.ledger.length, 1, 'uma única linha de razão');
    assert.equal(gw2.balanceOf('sender'), 1_000 - DIAMOND.coinCost);
  });

  it('recusa saldo insuficiente sem mexer no saldo', async () => {
    const gw = new InMemoryEconomyGateway(10);
    const res = await gw.chargeGift(req({ giftId: DIAMOND.id }));
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'insufficient_funds');
    assert.equal(gw.balanceOf('sender'), 10);
    assert.equal(gw.ledger.length, 0);
  });

  it('recusa quantidade fora do intervalo e presente desconhecido', async () => {
    const gw = new InMemoryEconomyGateway();
    assert.equal((await gw.chargeGift(req({ quantity: 0 }))).ok, false);
    assert.equal((await gw.chargeGift(req({ quantity: MAX_GIFT_QUANTITY + 1 }))).ok, false);
    assert.equal((await gw.chargeGift(req({ quantity: 1.5 }))).ok, false);
    assert.equal((await gw.chargeGift(req({ giftId: 'g_inexistente' }))).ok, false);
    assert.equal(gw.ledger.length, 0);
  });

  it('multiplica custo, creator points e pk points pela quantidade', async () => {
    const gw = new InMemoryEconomyGateway(10_000);
    const res = await gw.chargeGift(req({ giftId: ROSE.id, quantity: 50 }));
    assert.ok(res.ok);
    assert.equal(res.coinsSpent, ROSE.coinCost * 50);
    assert.equal(res.pkPoints, ROSE.pkPoints * 50);
    assert.equal(res.creatorPoints, ROSE.creatorPoints * 50);
  });

  it('sobe o nível de gifter conforme o gasto acumulado', async () => {
    const gw = new InMemoryEconomyGateway(1_000_000);
    const before = await gw.chargeGift(req({ giftId: ROSE.id, quantity: 1, idempotencyKey: 'k0' }));
    assert.ok(before.ok && before.gifterLevel === 0);

    const after = await gw.chargeGift(req({ giftId: DIAMOND.id, quantity: 2, idempotencyKey: 'k1' }));
    assert.ok(after.ok);
    assert.ok(after.gifterLevel >= 1, 'gastar 998 coins passa do primeiro degrau');
  });
});
