import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PresenceDirectory, type PresenceSnapshot } from '../src/social/PresenceDirectory.ts';

/** Relógio de mentira: TTL testado por tempo, não por espera. */
function clockedDirectory(ttlMs = 45_000) {
  let now = 1_000_000;
  const directory = new PresenceDirectory(ttlMs, () => now);
  return { directory, advance: (ms: number) => { now += ms; } };
}

function snapshot(
  serverId: string,
  entries: Array<[string, string, string]>,
  since = 1_000,
): PresenceSnapshot {
  return {
    serverId,
    at: 1_000_000,
    entries: entries.map(([userId, sceneId, roomId]) => ({
      userId, sceneId, roomId, kind: 'in_world' as const, since,
    })),
  };
}

describe('PresenceDirectory', () => {
  it('responde userId → sceneId → roomId', () => {
    const { directory } = clockedDirectory();
    directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']]));

    const location = directory.locationOf('ana');
    assert.equal(location?.sceneId, 'central_plaza');
    assert.equal(location?.roomId, 'shard_A');
    assert.equal(location?.serverId, 'gs_1');
  });

  it('quem some do retrato saiu da sala', () => {
    const { directory } = clockedDirectory();
    directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A'], ['beto', 'central_plaza', 'shard_A']]));
    directory.ingest(snapshot('gs_1', [['beto', 'central_plaza', 'shard_A']]));

    assert.equal(directory.locationOf('ana'), null);
    assert.equal(directory.locationOf('beto')?.roomId, 'shard_A');
    assert.equal(directory.onlineCount, 1);
  });

  it('um servidor não apaga os jogadores do outro', () => {
    const { directory } = clockedDirectory();
    directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']]));
    directory.ingest(snapshot('gs_2', [['beto', 'central_plaza', 'shard_B']]));

    assert.equal(directory.locationOf('ana')?.roomId, 'shard_A');
    assert.equal(directory.locationOf('beto')?.roomId, 'shard_B');
  });

  it('jogador que migra de processo fica com o registro do novo', () => {
    const h = clockedDirectory();
    // Chegou na praça de gs_1 às 1000, e no apartamento de gs_2 às 2000.
    h.directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']], 1_000));
    h.advance(1_000);
    h.directory.ingest(snapshot('gs_2', [['ana', 'apartment', 'apto_1']], 2_000));
    assert.equal(h.directory.locationOf('ana')?.serverId, 'gs_2');

    // Retrato ATRASADO do servidor antigo, tirado antes de ela sair e ainda
    // listando o endereço velho: chega depois, mas descreve um passado.
    h.advance(1);
    h.directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']], 1_000));
    assert.equal(h.directory.locationOf('ana')?.serverId, 'gs_2');
    assert.equal(h.directory.locationOf('ana')?.roomId, 'apto_1');
  });

  it('servidor que emudece leva junto quem ele declarava', () => {
    const h = clockedDirectory(45_000);
    h.directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']]));

    h.advance(30_000);
    assert.equal(h.directory.statusOf('ana'), 'in_world', 'um batimento perdido não derruba ninguém');

    h.advance(20_000);
    assert.equal(h.directory.statusOf('ana'), null, 'sem notícia além do TTL, o processo morreu');
    assert.equal(h.directory.onlineCount, 0);
  });

  it('batimento renova a fatia inteira', () => {
    const h = clockedDirectory(45_000);
    h.directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']]));
    h.advance(40_000);
    h.directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']]));
    h.advance(40_000);
    assert.equal(h.directory.statusOf('ana'), 'in_world');
  });

  it('offline é ausência de registro, não um estado guardado', () => {
    const { directory } = clockedDirectory();
    assert.equal(directory.statusOf('ninguem'), null);
    assert.equal(directory.locationOf('ninguem'), null);
  });

  it('status é grosso; localização é endereço', () => {
    const { directory } = clockedDirectory();
    directory.ingest({
      serverId: 'gs_1',
      at: 1_000_000,
      entries: [{ userId: 'ana', sceneId: 'live_room', roomId: 'live_9', kind: 'streaming', since: 1 }],
    });

    // O perfil de qualquer um pode dizer isto...
    assert.equal(directory.statusOf('ana'), 'streaming');
    // ...e só quem tiver direito recebe isto.
    assert.equal(directory.locationOf('ana')?.roomId, 'live_9');
  });

  it('statusesOf devolve só quem está em sala', () => {
    const { directory } = clockedDirectory();
    directory.ingest(snapshot('gs_1', [['ana', 'central_plaza', 'shard_A']]));
    const statuses = directory.statusesOf(['ana', 'beto']);
    assert.equal(statuses.get('ana'), 'in_world');
    assert.equal(statuses.has('beto'), false);
  });
});
