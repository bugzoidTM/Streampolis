import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntentionRow } from '../src/intentions.js';
import { EMPTY_INTERACTIONS } from '../src/intentions.js';
import { NOVELTY, noveltyLines, placesOfIntention, uneventful } from '../src/novelty.js';

/** O resumo de novidade, sem banco: o que ele conta ao modelo a partir do registro. */
const NOW = Date.UTC(2026, 8, 15, 20, 0, 0);
const min = (n: number) => new Date(NOW - n * 60_000);
let seq = 0;
const row = (p: Partial<IntentionRow> & { skill: string; goal: string }): IntentionRow => ({
  id: ++seq, why: null, params: {}, source: 'deliberation', outcome: 'done', exchanges: 0,
  startedAt: min(30), endedAt: min(17), world: null, arrived: true, arriveSec: 40, dwellSec: 600,
  interactions: { ...EMPTY_INTERACTIONS }, events: [], whyAudit: null, ...p,
});
const AVAILABLE = { places: ['Doca', 'Beco', 'Clube Sombra', 'Lavanderia'], skills: ['wander', 'go_to', 'rest', 'people_watch', 'patrol'] };

describe('resumo de novidade', () => {
  it('sem registro na janela, nada a dizer', () => {
    assert.deepEqual(noveltyLines({ recent: [], available: AVAILABLE, now: NOW }), []);
    const old = row({ skill: 'go_to', goal: 'x', params: { place: 'Doca' }, startedAt: new Date(NOW - NOVELTY.windowMs - 1) });
    assert.deepEqual(noveltyLines({ recent: [old], available: AVAILABLE, now: NOW }), []);
  });

  it('lugares visitados, repetições, objetivos sem novidade, interações e o não explorado', () => {
    const recent = [
      row({ skill: 'go_to', goal: 'Ir ao beco olhar o tambor', params: { place: 'Beco' }, startedAt: min(20), arrived: true, dwellSec: 300 }),
      row({ skill: 'go_to', goal: 'Ir ao beco ver o tambor de novo', params: { place: 'Beco' }, startedAt: min(60), arrived: false, arriveSec: null, dwellSec: null, outcome: 'expired' }),
      row({ skill: 'people_watch', goal: 'Ver quem passa na doca', params: { place: 'Doca' }, startedAt: min(90), exchanges: 2, interactions: { ...EMPTY_INTERACTIONS, exchanges: 2, spokeWith: ['Ana'], nearby: ['Ana', 'Zé'] } }),
      row({ skill: 'wander', goal: 'passear pela avenida', startedAt: min(120), events: [{ t: 30, what: 'começou a chover' }] }),
      // Pedido em conversa e passeio padrão não são experiência própria.
      row({ skill: 'go_to', goal: 'levar Ana até a Lavanderia', params: { place: 'Lavanderia' }, source: 'conversation', startedAt: min(10) }),
    ];
    const lines = noveltyLines({ recent, available: AVAILABLE, now: NOW });
    const text = lines.join('\n');
    assert.match(text, /Lugares visitados[^\n]*Beco \(2×, última há 20 min, chegou 1×, ficou 5 min em média\)/);
    assert.match(text, /Doca \(1×/);
    assert.doesNotMatch(text, /Lavanderia \(/, 'o pedido em conversa não conta como visita própria');
    assert.match(text, /Repetições: go_to → Beco 2×/);
    assert.match(text, /SEM novidade[^\n]*"Ir ao beco olhar o tambor"/);
    assert.doesNotMatch(text, /SEM novidade[^\n]*"Ver quem passa na doca"/, 'rendeu conversa');
    assert.doesNotMatch(text, /SEM novidade[^\n]*"passear pela avenida"/, 'aconteceu algo');
    assert.match(text, /Interações que você obteve: people_watch → Doca há 90 min: 2 conversa\(s\), com Ana, Zé/);
    assert.match(text, /NÃO explorado[^\n]*lugares: Clube Sombra, Lavanderia/);
    assert.match(text, /habilidades: rest, patrol/);
    assert.ok(lines.length <= NOVELTY.maxLines);
  });

  it('linha de antes da migration 0028 (chegada desconhecida) não vira "NÃO chegou"', () => {
    const lines = noveltyLines({ recent: [row({ skill: 'go_to', goal: 'x', params: { place: 'Doca' }, arrived: null, arriveSec: null, dwellSec: null })], available: AVAILABLE, now: NOW });
    assert.match(lines[0]!, /Doca \(1×, última há 30 min\)/);
  });

  it('sem interação nenhuma, diz isso — é dado, não silêncio', () => {
    const lines = noveltyLines({ recent: [row({ skill: 'rest', goal: 'descansar' })], available: AVAILABLE, now: NOW });
    assert.ok(lines.some((l) => /Interações que você obteve[^\n]*nenhuma/.test(l)));
  });

  it('"sem novidade" é: terminou, não falhou, ninguém e nada', () => {
    assert.equal(uneventful(row({ skill: 'rest', goal: 'a' })), true);
    assert.equal(uneventful(row({ skill: 'rest', goal: 'a', endedAt: null })), false);
    assert.equal(uneventful(row({ skill: 'rest', goal: 'a', outcome: 'failed' })), false);
    assert.equal(uneventful(row({ skill: 'rest', goal: 'a', interactions: { ...EMPTY_INTERACTIONS, heard: 1 } })), false);
    assert.equal(uneventful(row({ skill: 'rest', goal: 'a', events: [{ t: 1, what: 'Ana chegou' }] })), false);
    // Linha de antes da migration 0028: só o contador de trocas existe.
    assert.equal(uneventful(row({ skill: 'rest', goal: 'a', interactions: null, events: null, exchanges: 1 })), false);
  });

  it('os lugares de uma intenção', () => {
    assert.deepEqual(placesOfIntention('go_to', { place: 'Doca' }), ['Doca']);
    assert.deepEqual(placesOfIntention('patrol', { places: ['Doca', 'Beco'] }), ['Doca', 'Beco']);
    assert.deepEqual(placesOfIntention('queue_kiosk', { kiosk: 2 }), ['quiosque 2']);
    assert.deepEqual(placesOfIntention('wander', {}), []);
  });
});
