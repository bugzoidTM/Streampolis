import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAME_WEIGHTS, fameFrom, type FameParts } from '../src/profile/Fame.ts';

/**
 * A única regra dura do §22: **a fama não pode ser diretamente proporcional ao
 * dinheiro gasto por terceiros**. Creator Points são o rastro desse dinheiro,
 * então é aqui que essa frase vira teste — as outras parcelas são somas simples
 * e não têm o que esconder.
 */
const zero: FameParts = {
  viewers: 0, followers: 0, lives: 0, pkWins: 0, pkMatches: 0,
  missions: 0, eventPodiums: 0, creatorPoints: 0, activeDays: 0,
};

describe('fama (PRD §22)', () => {
  it('sem nada feito, fama zero', () => {
    assert.equal(fameFrom(zero), 0);
  });

  it('cem vezes mais dinheiro dos outros NÃO dá cem vezes mais fama', () => {
    const pouco = fameFrom({ ...zero, creatorPoints: 100 });
    const muito = fameFrom({ ...zero, creatorPoints: 10_000 });
    assert.ok(muito > pouco, 'mais presente ainda vale mais fama');
    // Raiz quadrada: 100× o dinheiro → 10× a fama. A margem cobre arredondamento.
    assert.ok(muito < pouco * 11, `esperava ~10×, veio ${muito / pouco}×`);
    assert.ok(muito > pouco * 9, `esperava ~10×, veio ${muito / pouco}×`);
  });

  it('quem aparece e transmite passa na frente de quem só recebeu presente caro', () => {
    // O baleado: um presente gigantesco, uma aparição.
    const presenteado = fameFrom({ ...zero, creatorPoints: 40_000, activeDays: 1, lives: 1 });
    // O consistente: um mês aparecendo, trinta lives, plateia modesta.
    const constante = fameFrom({
      ...zero, activeDays: 30, lives: 30, viewers: 150, followers: 20, missions: 5,
    });
    assert.ok(constante > presenteado,
      `consistência (${constante}) deveria passar do presente único (${presenteado})`);
  });

  it('consistência é a parcela com o maior peso — é a que não se compra', () => {
    const pesos = Object.entries(FAME_WEIGHTS).filter(([k]) => k !== 'creatorPointRoot');
    const maior = pesos.reduce((a, b) => (b[1] > a[1] ? b : a));
    assert.equal(maior[0], 'activeDay');
  });

  it('cada fonte do §22 soma alguma coisa', () => {
    for (const campo of ['viewers', 'followers', 'lives', 'pkWins', 'pkMatches',
      'missions', 'eventPodiums', 'activeDays'] as const) {
      assert.ok(fameFrom({ ...zero, [campo]: 1 }) > 0, `${campo} não somou nada`);
    }
  });

  /**
   * O §22 lista eventos entre as fontes, e um evento pode medir presentes
   * recebidos — ou seja, dinheiro de terceiros. Se a fama de evento viesse da
   * PONTUAÇÃO, a regra em negrito estaria furada por uma porta lateral. Vindo
   * da colocação, o teto de um evento é um pódio, e é isto que este teste
   * amarra: dez pódios ainda perdem para um mês de presença.
   */
  it('pódio em evento vale menos do que aparecer — o evento não é atalho', () => {
    const dezPodios = fameFrom({ ...zero, eventPodiums: 10 });
    const umMes = fameFrom({ ...zero, activeDays: 30 });
    assert.ok(dezPodios > 0, 'pódio precisa somar alguma coisa');
    assert.ok(umMes > dezPodios,
      `presença (${umMes}) deveria passar de dez pódios (${dezPodios})`);
  });

  it('número negativo (dado sujo) não vira fama negativa', () => {
    assert.equal(fameFrom({ ...zero, followers: -100 }), 0);
    assert.equal(fameFrom({ ...zero, creatorPoints: -1 }), 0);
  });

  it('o resultado é inteiro — fama fracionada não existe na tela', () => {
    const f = fameFrom({ ...zero, creatorPoints: 7 });
    assert.equal(f, Math.round(f));
  });
});
