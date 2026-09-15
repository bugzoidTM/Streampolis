import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RECENT_MIN, auditWhy, claimsOf, eventKind, factLines, type Facts } from '../src/grounding.js';
import { fold } from '../src/text.js';

/**
 * O "why" só afirma o que o mundo forneceu. Sem banco nem modelo: o que conta
 * como afirmação factual, o que a sustenta, e como a frase sem dado volta.
 */
const NOTHING: Facts = { weather: 'clear', night: false, people: [], events: [], seenToday: null };

describe('afirmações factuais no why', () => {
  it('reconhece ausência de gente, chuva, noite, luzes, chegada e mudança', () => {
    assert.ok(claimsOf(fold('Ninguém esteve aqui hoje.')).some((c) => c.state === 'nobody_today'));
    assert.deepEqual(claimsOf(fold('Começou a chover agora.'))[0]!.needs, ['rain_start']);
    assert.deepEqual(claimsOf(fold('Os postes acenderam há pouco.'))[0], { needs: ['nightfall'], recent: true });
    assert.deepEqual(claimsOf(fold('O letreiro mudou.'))[0], { needs: [], recent: false });
    assert.deepEqual(claimsOf(fold('Chegou gente nova na praça.'))[0]!.needs, ['arrival']);
  });

  it('a frase com hedge é impressão, não afirmação — passa', () => {
    const r = auditWhy('Acho que ninguém esteve aqui hoje. Quero ver se o letreiro mudou.', NOTHING);
    assert.deepEqual(r.unsupported, []);
    assert.equal(r.why, 'Acho que ninguém esteve aqui hoje. Quero ver se o letreiro mudou.');
  });

  it('a frase sem afirmação factual passa como está', () => {
    const r = auditWhy('Gosto do silêncio da doca à noite e o beco fica bonito na garoa.', NOTHING);
    assert.deepEqual(r.unsupported, []);
    // Estado, não evento: "não apaga" não afirma que algo apagou.
    assert.deepEqual(auditWhy('A chama é a única coisa que não apaga com a chuva fina.', NOTHING).unsupported, []);
    assert.equal(auditWhy('O néon acendeu.', NOTHING).unsupported.length, 1);
  });
});

describe('o que sustenta a afirmação', () => {
  it('"ninguém esteve aqui hoje" só com registro de hoje vazio e ninguém agora', () => {
    const why = 'Ninguém esteve aqui hoje.';
    assert.equal(auditWhy(why, NOTHING).unsupported.length, 1, 'sem registro de hoje não se sabe');
    assert.equal(auditWhy(why, { ...NOTHING, seenToday: [] }).unsupported.length, 0, 'registro de hoje vazio sustenta');
    assert.equal(auditWhy(why, { ...NOTHING, seenToday: ['Ana'] }).unsupported.length, 1, 'a Ana passou');
    assert.equal(auditWhy(why, { ...NOTHING, seenToday: [], people: ['Zé'] }).unsupported.length, 1, 'o Zé está aqui agora');
  });

  it('"começou a chover" precisa do evento; chover como estado não é evento', () => {
    const why = 'Começou a chover e o néon fica bonito molhado.';
    assert.equal(auditWhy(why, { ...NOTHING, weather: 'rain' }).unsupported.length, 1, 'está chovendo, mas ele não viu começar');
    assert.equal(auditWhy(why, { ...NOTHING, weather: 'rain', events: [{ what: 'começou a chover', ageMin: 40 }] }).unsupported.length, 0);
    assert.equal(auditWhy('Está chovendo e o néon fica bonito molhado.', { ...NOTHING, weather: 'rain' }).unsupported.length, 0);
  });

  it('"há pouco" exige evento recente; "acendeu" é a noite que caiu', () => {
    const why = 'Os postes acenderam há pouco.';
    assert.equal(auditWhy(why, { ...NOTHING, night: true }).unsupported.length, 1, 'é noite, mas ele não viu acender');
    assert.equal(auditWhy(why, { ...NOTHING, night: true, events: [{ what: 'anoiteceu', ageMin: RECENT_MIN + 30 }] }).unsupported.length, 1, 'anoiteceu, mas não há pouco');
    assert.equal(auditWhy(why, { ...NOTHING, night: true, events: [{ what: 'anoiteceu', ageMin: 5 }] }).unsupported.length, 0);
  });

  it('"o letreiro mudou" nunca tem dado; "alguém chegou" tem quando alguém chegou', () => {
    assert.equal(auditWhy('O letreiro mudou.', { ...NOTHING, events: [{ what: 'Ana chegou', ageMin: 2 }, { what: 'começou a chover', ageMin: 3 }] }).unsupported.length, 1);
    assert.equal(auditWhy('Alguém chegou pelo portão.', NOTHING).unsupported.length, 1);
    assert.equal(auditWhy('Alguém chegou pelo portão.', { ...NOTHING, events: [{ what: 'Ana chegou', ageMin: 2 }] }).unsupported.length, 0);
    // "a chuva chegou" é chuva, não gente.
    assert.equal(auditWhy('A chuva chegou.', { ...NOTHING, events: [{ what: 'Ana chegou', ageMin: 2 }] }).unsupported.length, 1);
    assert.equal(auditWhy('A chuva chegou.', { ...NOTHING, events: [{ what: 'começou a chover', ageMin: 2 }] }).unsupported.length, 0);
  });
});

describe('o registro', () => {
  it('só a frase sem dado é marcada; o resto fica como o modelo escreveu', () => {
    const r = auditWhy('O beco é meu canto. Ninguém esteve aqui hoje. Quero ver o tambor.', NOTHING);
    assert.deepEqual(r.unsupported, ['Ninguém esteve aqui hoje.']);
    assert.equal(r.why, 'O beco é meu canto. (suposição, sem dado) Ninguém esteve aqui hoje. Quero ver o tambor.');
  });

  it('why nulo ou vazio não quebra', () => {
    assert.deepEqual(auditWhy(null, NOTHING), { why: '', unsupported: [] });
    assert.deepEqual(auditWhy('', NOTHING), { why: '', unsupported: [] });
  });

  it('o bloco de fatos diz o que NÃO há dado, e que sem registro não se afirma que ninguém veio', () => {
    const lines = factLines(NOTHING, { weatherApplies: true });
    assert.ok(lines.some((l) => /não tem registro/.test(l)));
    assert.ok(lines.some((l) => /NÃO tem dado sobre: letreiros/.test(l)));
    assert.ok(factLines({ ...NOTHING, weather: null }, { weatherApplies: false }).some((l) => /não muda aqui/.test(l)));
  });

  it('classifica os eventos que o cérebro registra', () => {
    assert.equal(eventKind('começou a chover'), 'rain_start');
    assert.equal(eventKind('parou de chover'), 'rain_stop');
    assert.equal(eventKind('anoiteceu'), 'nightfall');
    assert.equal(eventKind('Ana chegou'), 'arrival');
    assert.equal(eventKind('Ana saiu'), 'departure');
    assert.equal(eventKind('sei lá'), null);
  });
});
