import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PKEngine, PK_COUNTDOWN_MS, type PKEvent } from '../src/pk/PKEngine.js';

/** Controllable clock — the whole point of injecting `now` into the engine. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) { t += ms; },
  };
}

const DURATION = 10_000;
const OVERTIME = 4_000;

function newEngine() {
  const c = clock();
  const pk = new PKEngine(c.now, DURATION, OVERTIME);
  return { c, pk };
}

/** Drives the engine to ACTIVE, which is where scoring is allowed. */
function toActive(pk: PKEngine, c: ReturnType<typeof clock>) {
  pk.start({ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }, 'battle_1');
  c.advance(PK_COUNTDOWN_MS);
  pk.update();
}

function finishedEvent(events: PKEvent[]) {
  return events.find((e) => e.kind === 'finished');
}

describe('PKEngine', () => {
  it('vai de WAITING a COUNTDOWN e depois a ACTIVE pelo relógio do servidor', () => {
    const { c, pk } = newEngine();
    assert.equal(pk.snapshot.phase, 'WAITING');

    pk.start({ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }, 'battle_1');
    assert.equal(pk.snapshot.phase, 'COUNTDOWN');
    assert.equal(pk.snapshot.endsAt, c.now() + PK_COUNTDOWN_MS);

    // Antes do prazo nada muda: o cliente não tem como acelerar a fase.
    assert.deepEqual(pk.update(), []);
    c.advance(PK_COUNTDOWN_MS);
    assert.deepEqual(pk.update(), [{ kind: 'phase', phase: 'ACTIVE' }]);
  });

  it('ignora pontos fora de ACTIVE/OVERTIME', () => {
    const { c, pk } = newEngine();
    pk.start({ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }, 'battle_1');

    assert.deepEqual(pk.addPoints('A', 100), []);
    assert.equal(pk.snapshot.scoreA, 0);

    c.advance(PK_COUNTDOWN_MS);
    pk.update();
    assert.deepEqual(pk.addPoints('A', 100), [{ kind: 'score', team: 'A', total: 100, delta: 100 }]);
  });

  it('resolve o vencedor pelo placar e emite exatamente um resultado', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);

    pk.addPointsForReceiver('a', 499);
    pk.addPointsForReceiver('b', 20);
    c.advance(DURATION);

    const events = pk.update();
    const done = finishedEvent(events);
    assert.ok(done && done.kind === 'finished');
    assert.equal(done.result.winnerId, 'a');
    assert.equal(done.result.loserId, 'b');
    assert.equal(done.result.draw, false);
    assert.equal(done.result.scoreA, 499);

    // Uma vez FINISHED, mais nenhum evento — nada de pagar duas vezes o prêmio.
    c.advance(DURATION);
    assert.deepEqual(pk.update(), []);
  });

  it('empate no tempo normal abre uma única prorrogação', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);
    pk.addPointsForReceiver('a', 50);
    pk.addPointsForReceiver('b', 50);

    c.advance(DURATION);
    assert.deepEqual(pk.update(), [{ kind: 'phase', phase: 'OVERTIME' }]);

    // Continua empatado ao fim da prorrogação: acaba em empate, não em outra.
    c.advance(OVERTIME);
    const done = finishedEvent(pk.update());
    assert.ok(done && done.kind === 'finished');
    assert.equal(done.result.draw, true);
    assert.equal(done.result.winnerId, '');
  });

  it('gift na prorrogação decide a batalha', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);
    pk.addPointsForReceiver('a', 10);
    pk.addPointsForReceiver('b', 10);
    c.advance(DURATION);
    pk.update();

    pk.addPointsForReceiver('b', 1);
    c.advance(OVERTIME);
    const done = finishedEvent(pk.update());
    assert.ok(done && done.kind === 'finished');
    assert.equal(done.result.winnerId, 'b');
  });

  it('não pontua para quem não está na batalha', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);
    assert.deepEqual(pk.addPointsForReceiver('intruso', 9999), []);
    assert.equal(pk.snapshot.scoreA, 0);
    assert.equal(pk.snapshot.scoreB, 0);
  });

  it('recusa start durante uma batalha em andamento', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);
    pk.addPointsForReceiver('a', 300);

    assert.deepEqual(pk.start({ id: 'c', name: 'Caio' }, { id: 'd', name: 'Duda' }, 'battle_2'), []);
    assert.equal(pk.snapshot.scoreA, 300, 'um segundo start não pode zerar o placar');
    assert.equal(pk.snapshot.hostA, 'a');
  });

  it('abort encerra e produz resultado', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);
    pk.addPointsForReceiver('a', 5);

    const done = finishedEvent(pk.abort('host_left'));
    assert.ok(done && done.kind === 'finished');
    assert.equal(done.result.winnerId, 'a');
    assert.equal(pk.snapshot.phase, 'FINISHED');
  });

  it('reset devolve o motor para WAITING', () => {
    const { c, pk } = newEngine();
    toActive(pk, c);
    pk.addPointsForReceiver('a', 5);
    pk.abort('admin');
    pk.reset();

    assert.equal(pk.snapshot.phase, 'WAITING');
    assert.equal(pk.snapshot.scoreA, 0);
    assert.equal(pk.teamOf('a'), null);
  });
});
