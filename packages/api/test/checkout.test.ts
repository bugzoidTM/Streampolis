import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { GIFT_DISCLOSURE, signatureMatches } from '../src/shop/Checkout.ts';

/**
 * A assinatura do webhook é a ÚNICA credencial do provedor de pagamento: quem
 * conseguir forjá-la credita Coins de graça. Por isso ela tem teste próprio, e
 * por isso os casos aqui são os do atacante, não os do caminho feliz.
 */
const SEGREDO = 'dev-only-webhook-secret';   // o mesmo default de config.ts fora de produção
const assina = (corpo: string) => createHmac('sha256', SEGREDO).update(corpo).digest('hex');

describe('assinatura do webhook de pagamento', () => {
  const corpo = JSON.stringify({ id: 'evt_1', type: 'payment.paid', paymentId: 'abc' });

  it('aceita a assinatura correta', () => {
    assert.equal(signatureMatches(corpo, assina(corpo)), true);
  });

  it('aceita o prefixo `sha256=`, que é como os gateways mandam', () => {
    assert.equal(signatureMatches(corpo, `sha256=${assina(corpo)}`), true);
  });

  it('recusa assinatura ausente', () => {
    assert.equal(signatureMatches(corpo, undefined), false);
    assert.equal(signatureMatches(corpo, ''), false);
  });

  it('recusa corpo adulterado com a assinatura do original', () => {
    const adulterado = JSON.stringify({ id: 'evt_1', type: 'payment.paid', paymentId: 'outro' });
    assert.equal(signatureMatches(adulterado, assina(corpo)), false);
  });

  it('recusa assinatura de outro segredo', () => {
    const outra = createHmac('sha256', 'segredo-do-atacante').update(corpo).digest('hex');
    assert.equal(signatureMatches(corpo, outra), false);
  });

  it('recusa prefixo correto com o resto truncado', () => {
    // O ataque que a comparação em tempo constante existe para não ajudar:
    // adivinhar byte a byte medindo quanto tempo a comparação leva. Aqui só se
    // verifica que um prefixo certo não passa.
    const certa = assina(corpo);
    assert.equal(signatureMatches(corpo, certa.slice(0, 32)), false);
    assert.equal(signatureMatches(corpo, `${certa.slice(0, 63)}0`), false);
  });

  it('o corpo cru em Buffer vale o mesmo que a string', () => {
    assert.equal(signatureMatches(Buffer.from(corpo, 'utf8'), assina(corpo)), true);
  });
});

describe('aviso obrigatório do PRD §15', () => {
  it('diz que presentear não transfere dinheiro', () => {
    assert.match(GIFT_DISCLOSURE, /não transfere dinheiro/i);
    assert.match(GIFT_DISCLOSURE, /não são resgatáveis|sacáveis/i);
  });
});
