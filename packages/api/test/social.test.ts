import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { friendshipStateFrom, orderedPair } from '../src/social/Friendships.ts';
import { ONBOARDING_STEPS, stepForPresence } from '../src/social/Onboarding.ts';
import { isReportType } from '../src/social/Moderation.ts';

/**
 * O que dá para provar sem banco — e é justamente onde moram as duas regras que
 * erram em silêncio: de que LADO veio um convite, e o que um registro de
 * presença prova sobre a volta guiada. As duas são leituras de ponto de vista,
 * e uma leitura invertida não quebra nada: só mostra a coisa errada na tela.
 */

const ANA = '11111111-1111-1111-1111-111111111111';
const BETO = '22222222-2222-2222-2222-222222222222';

describe('par ordenado da amizade', () => {
  it('a mesma dupla dá a mesma linha, venha na ordem que vier', () => {
    assert.deepEqual(orderedPair(ANA, BETO), orderedPair(BETO, ANA));
  });

  it('o menor vem primeiro (é o que o CHECK do schema exige)', () => {
    const [a, b] = orderedPair(BETO, ANA);
    assert.ok(a < b);
  });
});

describe('estado da amizade é ponto de vista', () => {
  it('a MESMA linha é enviado para quem pediu e recebido para o outro', () => {
    const row = { status: 'pending' as const, requested_by: ANA };
    assert.equal(friendshipStateFrom(ANA, row), 'outgoing');
    assert.equal(friendshipStateFrom(BETO, row), 'incoming');
  });

  it('aceita é amizade para os dois lados', () => {
    const row = { status: 'accepted' as const, requested_by: ANA };
    assert.equal(friendshipStateFrom(ANA, row), 'friends');
    assert.equal(friendshipStateFrom(BETO, row), 'friends');
  });

  it('o valor `blocked` do enum não vale amizade nenhuma', () => {
    // O bloqueio mora em `user_blocks`; este valor do enum é herança de 0003 e
    // nunca é escrito. Se um dia alguém o escrever, ele NÃO pode passar por
    // amizade — é isso que este teste tranca.
    const row = { status: 'blocked' as const, requested_by: ANA };
    assert.equal(friendshipStateFrom(ANA, row), 'none');
    assert.equal(friendshipStateFrom(BETO, row), 'none');
  });
});

describe('a presença prova o passo do onboarding', () => {
  it('estar na praça é ter entrado na praça', () => {
    assert.equal(stepForPresence({ sceneId: 'central_plaza', kind: 'in_world' }), 'enter_plaza');
  });

  it('assistir e transmitir são passos diferentes', () => {
    assert.equal(stepForPresence({ sceneId: 'live_room', kind: 'watching_live' }), 'watch_live');
    assert.equal(stepForPresence({ sceneId: 'live_room', kind: 'streaming' }), 'open_live');
  });

  it('PK é transmitir: quem está num PK já abriu a própria live', () => {
    assert.equal(stepForPresence({ sceneId: 'pk_arena', kind: 'in_pk' }), 'open_live');
  });

  it('o que a pessoa FAZ ganha da cena onde ela está', () => {
    // O caso que inverteria a regra: transmitir de casa. A cena é `apartment`,
    // mas quem transmite abriu uma live — marcar "visitou apartamento" aqui
    // acenderia o passo errado e deixaria o certo apagado.
    assert.equal(stepForPresence({ sceneId: 'apartment', kind: 'streaming' }), 'open_live');
    assert.equal(stepForPresence({ sceneId: 'apartment', kind: 'in_world' }), 'visit_apartment');
  });

  it('corredor não é passo', () => {
    assert.equal(stepForPresence({ sceneId: 'stream_store', kind: 'in_world' }), null);
    assert.equal(stepForPresence({ sceneId: 'residential_lobby', kind: 'in_world' }), null);
  });

  it('todo passo que a presença produz existe no roteiro', () => {
    // O roteiro e o mapeamento são duas listas, e elas se separam calado: um
    // passo derivado que não está no CHECK da tabela vira INSERT recusado, e a
    // recusa é engolida de propósito (o onboarding não pode derrubar presença).
    const cenas = ['central_plaza', 'apartment', 'live_room', 'pk_arena', 'stream_store'] as const;
    const kinds = ['in_world', 'watching_live', 'streaming', 'in_pk'] as const;
    for (const sceneId of cenas) {
      for (const kind of kinds) {
        const step = stepForPresence({ sceneId, kind });
        if (step) assert.ok(ONBOARDING_STEPS.includes(step), `${sceneId}/${kind} → ${step}`);
      }
    }
  });
});

describe('tipos de denúncia', () => {
  it('aceita só os cinco que o CHECK da tabela conhece', () => {
    for (const t of ['chat', 'profile', 'live', 'avatar', 'other']) {
      assert.equal(isReportType(t), true, t);
    }
    assert.equal(isReportType('spam'), false);
    assert.equal(isReportType(''), false);
    assert.equal(isReportType(undefined), false);
  });
});
