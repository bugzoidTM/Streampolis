import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SocialSignals } from '../src/world/SocialSignals.js';

/**
 * O acumulador que alimenta a North Star (PRD §32). O que importa provar aqui
 * é o que ele NÃO faz: repetir a mesma pessoa mil vezes, e esquecer o que ainda
 * não foi entregue.
 */
function espiao() {
  const lotes: Array<Array<{ userId: string; kind: string }>> = [];
  let falhar = false;
  return {
    lotes,
    falharNaProxima: () => { falhar = true; },
    pararDeFalhar: () => { falhar = false; },
    async reportSocial(entries: Array<{ userId: string; kind: string }>) {
      if (falhar) throw new Error('API fora');
      lotes.push(entries.map((e) => ({ ...e })));
    },
  };
}

describe('SocialSignals', () => {
  it('mil mensagens da mesma pessoa viram um relato', async () => {
    const sink = espiao();
    const s = new SocialSignals({ sink, autoFlush: false });
    for (let i = 0; i < 1_000; i++) s.mark('ana', 'chat');
    assert.equal(s.pending, 1);
    await s.flush();
    assert.equal(sink.lotes.length, 1);
    assert.deepEqual(sink.lotes[0], [{ userId: 'ana', kind: 'chat' }]);
  });

  it('depois de reportado, não reporta de novo no mesmo dia', async () => {
    const sink = espiao();
    const s = new SocialSignals({ sink, autoFlush: false });
    s.mark('ana', 'chat');
    await s.flush();
    s.mark('ana', 'chat');
    await s.flush();
    assert.equal(sink.lotes.length, 1, 'o segundo flush não deveria mandar nada');
  });

  it('tipos diferentes da mesma pessoa são interações diferentes', async () => {
    const sink = espiao();
    const s = new SocialSignals({ sink, autoFlush: false });
    s.mark('ana', 'chat');
    s.mark('ana', 'visit');
    await s.flush();
    assert.equal(sink.lotes[0].length, 2);
  });

  it('lote perdido volta na próxima janela em vez de sumir', async () => {
    const sink = espiao();
    const s = new SocialSignals({ sink, autoFlush: false });
    s.mark('beto', 'pk');
    sink.falharNaProxima();
    await s.flush();
    assert.equal(sink.lotes.length, 0);
    assert.equal(s.pending, 1, 'continua pendente');
    sink.pararDeFalhar();
    await s.flush();
    assert.deepEqual(sink.lotes[0], [{ userId: 'beto', kind: 'pk' }]);
  });

  it('vira o dia, a mesma pessoa volta a contar', async () => {
    const sink = espiao();
    // 23:30 e 00:30 no fuso do jogador, em dias diferentes.
    let agora = Date.parse('2026-09-06T02:30:00Z');   // 23:30 de 05/09 em SP
    const s = new SocialSignals({ sink, autoFlush: false, now: () => agora });
    s.mark('ana', 'chat');
    await s.flush();
    agora = Date.parse('2026-09-06T04:30:00Z');       // 01:30 de 06/09 em SP
    s.mark('ana', 'chat');
    await s.flush();
    assert.equal(sink.lotes.length, 2, 'o dia novo é um relato novo');
  });

  it('id vazio não vira relato', async () => {
    const sink = espiao();
    const s = new SocialSignals({ sink, autoFlush: false });
    s.mark('', 'chat');
    await s.flush();
    assert.equal(sink.lotes.length, 0);
  });
});
