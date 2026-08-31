import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChatGuard } from '../src/social/ChatGuard.js';
import { LikeAggregator } from '../src/social/LikeAggregator.js';
import { CHAT_RATE_LIMIT, LIKE_RATE_LIMIT, MAX_CHAT_LEN } from '../src/shared.js';

describe('ChatGuard', () => {
  it('recusa vazio e excesso de tamanho', () => {
    const guard = new ChatGuard();
    assert.equal(guard.check('u1', '   ').ok, false);
    assert.equal(guard.check('u1', 'x'.repeat(MAX_CHAT_LEN + 1)).ok, false);
  });

  it('aplica rate limit por janela', () => {
    let t = 0;
    const guard = new ChatGuard({ now: () => t });
    for (let i = 0; i < CHAT_RATE_LIMIT.messages; i++) {
      assert.equal(guard.check('u1', `msg ${i}`).ok, true);
      t += 10;
    }
    assert.equal(guard.check('u1', 'mais uma').ok, false);

    t += CHAT_RATE_LIMIT.windowMs;
    assert.equal(guard.check('u1', 'depois da janela').ok, true);
  });

  it('bloqueia repetição imediata', () => {
    let t = 0;
    const guard = new ChatGuard({ now: () => t });
    assert.equal(guard.check('u1', 'oi').ok, true);
    t += 100;
    const second = guard.check('u1', 'oi');
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'duplicate');
  });

  it('mascara palavrão mesmo com leet e repetição', () => {
    const guard = new ChatGuard();
    const verdict = guard.check('u1', 'que m3rrrda de dia');
    assert.ok(verdict.ok);
    assert.equal(verdict.filtered, true);
    assert.ok(!verdict.text.includes('m3rrrda'));
  });

  it('mute expira sozinho', () => {
    let t = 0;
    const guard = new ChatGuard({ now: () => t });
    guard.mute('u1', 1_000);
    assert.equal(guard.check('u1', 'oi').ok, false);
    t = 1_001;
    assert.equal(guard.check('u1', 'oi').ok, true);
  });

  it('block é por espectador, não derruba o remetente', () => {
    const guard = new ChatGuard();
    guard.block('viewer', 'chato');
    assert.equal(guard.blocksSender('viewer', 'chato'), true);
    assert.equal(guard.blocksSender('outro', 'chato'), false);
    assert.equal(guard.check('chato', 'ainda falo').ok, true);
  });
});

describe('LikeAggregator', () => {
  it('limita likes por janela e devolve quantos entraram', () => {
    let t = 0;
    const likes = new LikeAggregator(() => t);
    assert.equal(likes.add('u1', LIKE_RATE_LIMIT.likes), LIKE_RATE_LIMIT.likes);
    assert.equal(likes.add('u1', 5), 0);

    t += LIKE_RATE_LIMIT.windowMs + 1;
    assert.equal(likes.add('u1', 3), 3);
  });

  it('flush entrega o delta uma única vez', () => {
    const likes = new LikeAggregator();
    likes.add('u1', 4);
    assert.deepEqual(likes.flush(), { total: 4, delta: 4 });
    assert.deepEqual(likes.flush(), { total: 4, delta: 0 });
  });
});
