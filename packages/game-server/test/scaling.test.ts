import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScaling, validateScaling } from '../src/scaling.js';

describe('distributed game-server configuration', () => {
  it('keeps local development independent of Redis', async () => {
    const local = createScaling({ redisUrl: '', publicAddress: '', distributed: false });
    assert.equal(local.mode, 'local');
    assert.equal(local.serverOptions.presence, undefined);
    assert.equal(local.serverOptions.driver, undefined);
    assert.equal(await local.ready(), true);
  });

  it('refuses distributed mode without shared Redis or worker routing', () => {
    assert.throws(() => validateScaling({ redisUrl: '', publicAddress: 'game.test/ws/1', distributed: true }), /REDIS_URL/);
    assert.throws(() => validateScaling({ redisUrl: 'redis://localhost:6379', publicAddress: '', distributed: false }), /PUBLIC_ADDRESS/);
  });

  it('accepts worker paths and rejects schemes that would break SDK WebSocket URLs', () => {
    const base = { redisUrl: 'redis://localhost:6379/2', distributed: true };
    assert.doesNotThrow(() => validateScaling({ ...base, publicAddress: 'game.test/ws/1' }));
    assert.doesNotThrow(() => validateScaling({ ...base, publicAddress: '127.0.0.1:2567' }));
    for (const publicAddress of ['wss://game.test/ws/1', 'game.test?worker=1', 'user:pass@game.test', 'game.test/ws 1']) {
      assert.throws(() => validateScaling({ ...base, publicAddress }), /PUBLIC_ADDRESS/);
    }
    assert.throws(() => validateScaling({ ...base, publicAddress: 'game.test', redisUrl: 'https://localhost' }), /REDIS_URL/);
  });
});
