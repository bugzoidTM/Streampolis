import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PresenceTracker } from '../src/world/Presence.js';
import type { PresenceSnapshot } from '../src/shared.js';

/** Sink de teste: guarda todo retrato publicado, sem rede. */
function harness(startAt = 1_000) {
  const published: PresenceSnapshot[] = [];
  let clock = startAt;
  const tracker = new PresenceTracker({
    serverId: 'gs_test',
    now: () => clock,
    autoFlush: false,
    sink: { async publishPresence(snapshot) { published.push(snapshot); } },
  });
  return {
    tracker,
    published,
    advance: (ms: number) => { clock += ms; },
    at: () => clock,
  };
}

describe('PresenceTracker', () => {
  it('registra userId, sceneId e roomId', () => {
    const { tracker, at } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });

    assert.deepEqual(tracker.locationOf('ana'), {
      userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world', since: at(),
    });
  });

  it('trocar de shard reinicia o "desde"; trocar de papel não', () => {
    const h = harness();
    h.tracker.enter({ userId: 'ana', sceneId: 'live_room', roomId: 'live_1', kind: 'watching_live' });
    const arrived = h.tracker.locationOf('ana')?.since;

    h.advance(60_000);
    // Subiu ao palco: mesma sala, outro papel — está ali desde que chegou.
    h.tracker.enter({ userId: 'ana', sceneId: 'live_room', roomId: 'live_1', kind: 'streaming' });
    assert.equal(h.tracker.locationOf('ana')?.kind, 'streaming');
    assert.equal(h.tracker.locationOf('ana')?.since, arrived);

    h.advance(60_000);
    h.tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    assert.equal(h.tracker.locationOf('ana')?.since, h.at());
  });

  it('um jogador está em uma sala só', () => {
    const { tracker } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    tracker.enter({ userId: 'ana', sceneId: 'apartment', roomId: 'apto_1', kind: 'in_world' });
    assert.equal(tracker.size, 1);
    assert.equal(tracker.locationOf('ana')?.roomId, 'apto_1');
  });

  it('saída atrasada do portal não apaga a presença nova', () => {
    const { tracker } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    // Atravessou o portal: entra na casa e SÓ ENTÃO a praça percebe a queda.
    tracker.enter({ userId: 'ana', sceneId: 'apartment', roomId: 'apto_1', kind: 'in_world' });
    tracker.leave('ana', 'shard_A');

    assert.equal(tracker.locationOf('ana')?.roomId, 'apto_1',
      'a saída da sala velha não pode derrubar a entrada na sala nova');
  });

  it('sair da sala em que se está apaga a presença', () => {
    const { tracker } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    tracker.leave('ana', 'shard_A');
    assert.equal(tracker.locationOf('ana'), undefined);
  });

  it('sala que morre leva junto todo mundo que estava nela', () => {
    const { tracker } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    tracker.enter({ userId: 'beto', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    tracker.enter({ userId: 'caio', sceneId: 'central_plaza', roomId: 'shard_B', kind: 'in_world' });

    tracker.dropRoom('shard_A');
    assert.equal(tracker.size, 1);
    assert.equal(tracker.locationOf('caio')?.roomId, 'shard_B');
  });

  it('publica o retrato inteiro, nunca um delta', async () => {
    const { tracker, published } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    tracker.enter({ userId: 'beto', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    await tracker.flush();

    assert.equal(published.length, 1);
    assert.equal(published[0].serverId, 'gs_test');
    assert.deepEqual(published[0].entries.map((e) => e.userId).sort(), ['ana', 'beto']);

    tracker.leave('ana', 'shard_A');
    await tracker.flush();
    // Não é "ana saiu": é a cidade inteira deste processo, de novo.
    assert.deepEqual(published[1].entries.map((e) => e.userId), ['beto']);
  });

  it('reanunciar o mesmo estado não conta como mudança', () => {
    const { tracker } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    const afterJoin = tracker.revision;

    // É o que a live faz a cada mudança de audiência: reanuncia todo mundo.
    // Sem isto, um espectador entrando agendaria um POST por jogador da sala.
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    assert.equal(tracker.revision, afterJoin);

    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'streaming' });
    assert.equal(tracker.revision, afterJoin + 1, 'mudar de papel é mudança');
  });

  it('sair de sala em que não se está é no-op', () => {
    const { tracker } = harness();
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    const before = tracker.revision;
    tracker.leave('ana', 'shard_B');
    tracker.leave('ninguem', 'shard_A');
    tracker.dropRoom('shard_Z');
    assert.equal(tracker.revision, before);
    assert.equal(tracker.locationOf('ana')?.roomId, 'shard_A');
  });

  it('servidor vazio e parado não acorda a API', async () => {
    const { tracker, published } = harness();
    await tracker.flush();
    await tracker.flush();
    assert.equal(published.length, 0);

    // Mas o esvaziamento em si precisa ser anunciado: a API tem de saber que a
    // sala ficou vazia, senão o último jogador fica no mapa até o TTL vencer.
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    await tracker.flush();
    tracker.leave('ana', 'shard_A');
    await tracker.flush();
    assert.equal(published.length, 2);
    assert.deepEqual(published[1].entries, []);
  });

  it('falha de rede não deixa o rastreador travado', async () => {
    let fail = true;
    const tracker = new PresenceTracker({
      serverId: 'gs_test', autoFlush: false,
      sink: {
        async publishPresence() {
          if (fail) throw new Error('API fora do ar');
        },
      },
    });
    tracker.enter({ userId: 'ana', sceneId: 'central_plaza', roomId: 'shard_A', kind: 'in_world' });
    await tracker.flush();
    fail = false;
    // O retrato seguinte carrega o estado inteiro: nada a reenviar, nada a
    // perder — é a propriedade que justifica o protocolo.
    await assert.doesNotReject(tracker.flush());
    assert.equal(tracker.locationOf('ana')?.roomId, 'shard_A');
  });
});
