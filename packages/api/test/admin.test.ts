import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { permissionsFor } from '../src/auth/identity.ts';
import { isSanctionAction } from '../src/admin/AdminService.ts';

/**
 * Quem pode falar, e quem pode punir. As duas regras que o painel administrativo
 * carrega e que não podem depender de o banco estar de pé para serem testadas.
 */
describe('permissões assinadas no token', () => {
  const agora = new Date('2026-09-06T12:00:00Z');
  const daqui = (min: number) => new Date(agora.getTime() + min * 60_000);

  it('jogador comum joga e nada mais', () => {
    assert.deepEqual(permissionsFor('player', null, agora), ['play']);
  });

  it('moderador modera; admin também administra', () => {
    assert.deepEqual(permissionsFor('moderator', null, agora), ['play', 'moderate']);
    assert.deepEqual(permissionsFor('admin', null, agora), ['play', 'moderate', 'admin']);
  });

  it('silêncio é marca NEGATIVA: some do token quem não foi silenciado', () => {
    // A escolha importa: exigir uma permissão positiva de chat calaria todo
    // token já emitido no momento do deploy.
    assert.ok(!permissionsFor('player', null, agora).includes('muted'));
  });

  it('silêncio no futuro marca; silêncio vencido não marca', () => {
    assert.ok(permissionsFor('player', daqui(30), agora).includes('muted'));
    assert.ok(!permissionsFor('player', daqui(-1), agora).includes('muted'));
  });

  it('silêncio não tira as outras permissões de quem é da equipe', () => {
    const perms = permissionsFor('moderator', daqui(10), agora);
    assert.ok(perms.includes('moderate'));
    assert.ok(perms.includes('muted'));
  });

  it('papel desconhecido cai para o mínimo', () => {
    assert.deepEqual(permissionsFor('deus', null, agora), ['play']);
  });
});

describe('ações de sanção aceitas', () => {
  it('aceita só a lista fechada', () => {
    for (const boa of ['suspend', 'ban', 'mute', 'unmute', 'reinstate']) {
      assert.equal(isSanctionAction(boa), true, boa);
    }
    for (const ruim of ['delete', 'drop', '', 'SUSPEND', null, 42, undefined]) {
      assert.equal(isSanctionAction(ruim), false, String(ruim));
    }
  });
});
