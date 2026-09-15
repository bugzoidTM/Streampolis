import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FATIGUE, assessFatigue, fatigueLines, goalSimilarity, targetKey, worldChange, type PastIntention, type WorldSnapshot } from '../src/fatigue.js';

/**
 * A fadiga de intenção, sem banco nem modelo: o que conta como "a mesma
 * coisa", o que conta como "o mundo mudou", e quando o portão fecha.
 */
const NOW = Date.UTC(2026, 8, 15, 8, 0, 0);
const min = (n: number) => new Date(NOW - n * 60_000);
const RAIN: WorldSnapshot = { weather: 'rain', night: true, people: [] };
const CLEAR: WorldSnapshot = { weather: 'clear', night: true, people: [] };
const past = (p: Partial<PastIntention> & { skill: string; goal: string }): PastIntention => ({ params: {}, startedAt: min(10), world: RAIN, ...p });

describe('alvo e objetivo equivalentes', () => {
  it('a chave de alvo junta habilidade e lugar canônico; sem parâmetro, é a própria habilidade', () => {
    assert.equal(targetKey('go_to', { place: 'Fundos do beco' }), 'go_to:fundos do beco');
    assert.equal(targetKey('patrol', { places: ['Doca', 'Beco'] }), targetKey('patrol', { places: ['beco', 'doca', 'Beco'] }));
    assert.equal(targetKey('wander', {}), 'wander');
    assert.notEqual(targetKey('go_to', { place: 'Doca' }), targetKey('go_to', { place: 'Beco' }));
  });

  it('o mesmo objetivo dito de outro jeito é o mesmo objetivo', () => {
    const a = 'Ir até a porta do Clube Sombra e observar o néon piscando na chuva';
    const b = 'Ir até a porta do Clube Sombra e observar o néon sem chuva';
    const c = 'Ir até a doca de carga e observar as poças refletindo o néon amarelo';
    assert.ok(goalSimilarity(a, b) >= FATIGUE.goalSimilarity, `equivalentes: ${goalSimilarity(a, b)}`);
    assert.ok(goalSimilarity(a, c) < FATIGUE.goalSimilarity, `diferentes: ${goalSimilarity(a, c)}`);
  });
});

describe('mudança factual no mundo', () => {
  it('chuva, noite e gente nova contam; o resto não', () => {
    assert.equal(worldChange(RAIN, RAIN), null);
    assert.equal(worldChange(RAIN, CLEAR), 'parou de chover');
    assert.equal(worldChange(CLEAR, { ...CLEAR, night: false }), 'amanheceu');
    assert.equal(worldChange(CLEAR, { ...CLEAR, people: ['u1'] }), 'chegou alguém que não estava');
    // Alguém que já estava e foi embora não é novidade que justifique repetir.
    assert.equal(worldChange({ ...CLEAR, people: ['u1'] }, CLEAR), null);
    assert.equal(worldChange(null, RAIN), null, 'sem retrato antigo não há como saber: não isenta');
  });
});

describe('o portão da fadiga', () => {
  const tambor = { goal: 'Ir até os fundos do beco e observar o tambor aceso', skill: 'go_to', params: { place: 'Fundos do beco' } };

  it('repetir o mesmo alvo há pouco, no mesmo mundo, fecha o portão', () => {
    const f = assessFatigue(tambor, [past({ ...tambor, startedAt: min(13) })], RAIN, NOW);
    assert.equal(f.matches.length, 1);
    assert.equal(f.matches[0]!.how, 'target');
    assert.ok(f.blocked, `cansaço ${f.score}`);
  });

  it('a mesma coisa com o mundo mudado passa — mas a terceira vez no mesmo mundo da primeira não', () => {
    const first = past({ ...tambor, startedAt: min(40), world: RAIN });
    const ok = assessFatigue(tambor, [first], CLEAR, NOW);
    assert.equal(ok.blocked, false);
    assert.equal(ok.matches[0]!.changed, 'parou de chover');
    // Choveu de novo: o mundo é o mesmo de 40 min atrás, quando ele já foi lá.
    const second = past({ ...tambor, startedAt: min(15), world: CLEAR });
    const again = assessFatigue(tambor, [first, second], RAIN, NOW);
    assert.ok(again.blocked, 'a alternância chuva/sol não é salvo-conduto');
  });

  it('o cansaço decai: a mesma coisa há quase duas horas não pesa', () => {
    const f = assessFatigue(tambor, [past({ ...tambor, startedAt: min(110) })], RAIN, NOW);
    assert.equal(f.blocked, false);
    assert.ok(f.score < 0.1);
    const out = assessFatigue(tambor, [past({ ...tambor, startedAt: min(130) })], RAIN, NOW);
    assert.equal(out.matches.length, 0, 'fora da janela nem aparece');
  });

  it('objetivo equivalente com a mesma habilidade cansa; outro alvo não', () => {
    const clube = { goal: 'Ir até a porta do Clube Sombra e observar o néon piscando na chuva', skill: 'go_to', params: { place: 'Clube Sombra' } };
    const clubeSeco = { goal: 'Ir até a porta do Clube Sombra e observar o néon sem chuva', skill: 'go_to', params: { place: 'Porta do clube' } };
    const f = assessFatigue(clubeSeco, [past({ ...clube, startedAt: min(20) })], RAIN, NOW);
    assert.ok(f.blocked);
    assert.equal(f.matches[0]!.how, 'goal');
    const doca = { goal: 'Ir até a doca de carga e observar as poças', skill: 'go_to', params: { place: 'Doca de carga' } };
    assert.equal(assessFatigue(doca, [past({ ...clube, startedAt: min(20) })], RAIN, NOW).blocked, false);
  });

  it('habilidade sem parâmetro repetida em seguida também cansa', () => {
    const w = { goal: 'Passear pela avenida parando nas poças', skill: 'wander', params: {} };
    assert.ok(assessFatigue(w, [past({ goal: 'Dar uma volta pela avenida', skill: 'wander', startedAt: min(25) })], RAIN, NOW).blocked);
  });

  it('as linhas do prompt dizem o que está cansado e o que só precisa de motivo', () => {
    const lines = fatigueLines([
      past({ ...tambor, startedAt: min(12) }),
      past({ ...tambor, startedAt: min(50) }),
      past({ goal: 'Ir à doca', skill: 'go_to', params: { place: 'Doca' }, startedAt: min(30), world: CLEAR }),
    ], RAIN, NOW);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /go_to → Fundos do beco: 2× .*última há 12 min.*CANSADO/);
    assert.match(lines[1]!, /go_to → Doca: 1× .*só se algo mudou/);
  });
});
