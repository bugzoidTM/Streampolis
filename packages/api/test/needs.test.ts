import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { needsFrom, type NeedFacts } from '../src/profile/Needs.ts';

/**
 * O §9 tem uma frase que é uma proibição: "esses sistemas não deverão impedir o
 * jogador de participar do jogo de maneira excessivamente punitiva". Estes
 * testes são a guarda dela — e o caso mais importante é o do jogador que sumiu
 * por três dias, porque é ele que um simulador de vida costuma castigar.
 */
const nada: NeedFacts = {
  recentLiveHours: [], recentPkHours: [], socialKinds7d: 0, activeDays7d: 0,
  furniture: 0, furnitureValue: 0, goodEvents48h: 0,
};

describe('necessidades (PRD §9)', () => {
  it('quem sumiu por três dias volta DESCANSADO, não castigado', () => {
    const voltando = needsFrom(nada);
    assert.equal(voltando.energia, 100, 'ficar fora é descanso, não penalidade');
  });

  it('nenhum atributo é negativo, e a energia tem piso', () => {
    const exausto = needsFrom({
      ...nada,
      recentLiveHours: [0, 0, 0, 0, 0, 0, 0, 0],
      recentPkHours: [0, 0, 0, 0, 0, 0],
    });
    assert.ok(exausto.energia >= 25, `energia caiu para ${exausto.energia}`);
    for (const [k, v] of Object.entries(exausto)) {
      assert.ok(v >= 0 && v <= 100, `${k} fora da faixa: ${v}`);
    }
  });

  it('o cansaço se desfaz com o tempo, sozinho', () => {
    const agora = needsFrom({ ...nada, recentLiveHours: [0] });
    const depois = needsFrom({ ...nada, recentLiveHours: [6] });
    const ontem = needsFrom({ ...nada, recentLiveHours: [13] });
    assert.ok(agora.energia < depois.energia, 'seis horas depois tem de cansar menos');
    assert.equal(ontem.energia, 100, 'treze horas depois não pode sobrar cansaço');
  });

  it('social premia VARIEDADE de interação, não volume', () => {
    // O §9 diz que as necessidades servem para "incentivar variedade".
    const umTipoTodoDia = needsFrom({ ...nada, socialKinds7d: 1, activeDays7d: 7 });
    const muitosTipos = needsFrom({ ...nada, socialKinds7d: 6, activeDays7d: 3 });
    assert.ok(muitosTipos.social > umTipoTodoDia.social);
  });

  it('conforto vem da casa e NÃO decai com o tempo (não há tempo na conta)', () => {
    const vazia = needsFrom(nada);
    const mobiliada = needsFrom({ ...nada, furniture: 5, furnitureValue: 1_500 });
    assert.ok(mobiliada.conforto > vazia.conforto);
    // A mesma casa dá o mesmo conforto, não importa quando se olhe: a função
    // não recebe tempo nenhum, e este teste existe para que continue assim.
    assert.equal(needsFrom({ ...nada, furniture: 5, furnitureValue: 1_500 }).conforto,
      mobiliada.conforto);
  });

  it('humor melhora com as outras três e com acontecimentos bons', () => {
    const cinza = needsFrom(nada);
    const bem = needsFrom({
      ...nada, socialKinds7d: 6, activeDays7d: 6, furniture: 6, furnitureValue: 2_000,
    });
    assert.ok(bem.humor > cinza.humor);
    const comPresente = needsFrom({ ...nada, goodEvents48h: 3 });
    assert.ok(comPresente.humor > cinza.humor, 'presente recebido levanta o humor');
  });

  it('o bônus de acontecimentos tem teto — nada de humor comprado', () => {
    const tres = needsFrom({ ...nada, goodEvents48h: 3 });
    const trezentos = needsFrom({ ...nada, goodEvents48h: 300 });
    assert.equal(trezentos.humor, tres.humor,
      'presentear em massa não pode ser um atalho para o humor máximo');
  });
});
