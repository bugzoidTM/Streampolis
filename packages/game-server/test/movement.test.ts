import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MovementController, sanitizeIntent, SPEED_AUDIT_WINDOW_MS } from '../src/sim/Movement.js';
import {
  applyMoveIntent, FIXED_DT, INTENT_QUEUE_LIMIT, MAX_SPEED, PLAYER_RADIUS, PLAY_AREA,
  PLAZA, SCENE_AREA, SCENE_COLLIDERS,
} from '../src/shared.js';

const AREA = PLAY_AREA.central_plaza;
const SPAWN = { x: 0, y: 0, z: 0, yaw: 0, moving: false };

function controller(now: () => number = () => 1_000) {
  return new MovementController({ ...SPAWN }, AREA, now);
}

describe('sanitizeIntent', () => {
  it('recusa o que não é intent', () => {
    assert.equal(sanitizeIntent(null), null);
    assert.equal(sanitizeIntent('andar'), null);
    assert.equal(sanitizeIntent({ dx: Number.NaN, dz: 0, yaw: 0, seq: 1 }), null);
    assert.equal(sanitizeIntent({ dx: 0, dz: 0, yaw: Infinity, seq: 1 }), null);
    assert.equal(sanitizeIntent({ dx: 0, dz: 0, yaw: 0, seq: 1.5 }), null);
  });

  it('normaliza yaw e trata run como booleano estrito', () => {
    const intent = sanitizeIntent({ dx: 0, dz: 1, yaw: Math.PI * 3, seq: 2, run: 'sim' });
    assert.ok(intent);
    assert.ok(Math.abs(intent.yaw) <= Math.PI);
    assert.equal(intent.run, false, 'string não vira corrida');
  });
});

describe('MovementController', () => {
  it('integra o mesmo passo que o cliente prevê', () => {
    const mc = controller();
    const intent = { dx: 0, dz: 1, yaw: 0, run: false, seq: 1 };
    mc.enqueue(intent);
    const out = mc.step();

    const predicted = applyMoveIntent({ x: 0, z: 0, yaw: 0, moving: false }, intent, AREA);
    assert.equal(out.pose.z, predicted.z);
    assert.equal(out.pose.x, predicted.x);
    assert.equal(out.lastSeq, 1);
    assert.equal(out.pose.moving, true);
  });

  it('descarta sequência repetida ou antiga', () => {
    const mc = controller();
    mc.enqueue({ dx: 0, dz: 1, yaw: 0, seq: 5 });
    mc.step();
    assert.equal(mc.enqueue({ dx: 0, dz: 1, yaw: 0, seq: 5 }), 'stale_seq');
    assert.equal(mc.enqueue({ dx: 0, dz: 1, yaw: 0, seq: 4 }), 'stale_seq');
  });

  it('estrangula flood e pede correção', () => {
    const mc = controller();
    for (let i = 1; i <= INTENT_QUEUE_LIMIT; i++) {
      assert.equal(mc.enqueue({ dx: 0, dz: 1, yaw: 0, seq: i }), null);
    }
    assert.equal(mc.enqueue({ dx: 0, dz: 1, yaw: 0, seq: 999 }), 'flood');
    assert.equal(mc.step().corrected, true);
  });

  it('consome no máximo o orçamento de intents por tick', () => {
    const mc = controller();
    for (let i = 1; i <= 9; i++) mc.enqueue({ dx: 0, dz: 1, yaw: 0, seq: i });
    const first = mc.step();
    // Andando a passo, 9 intents em um tick só seriam 9x a velocidade legal.
    const walkedInOneTick = MAX_SPEED.walk * FIXED_DT;
    assert.ok(first.pose.z <= walkedInOneTick * 3 + 1e-9);
  });

  it('mantém o jogador dentro da área permitida', () => {
    const mc = new MovementController({ x: AREA.maxX - 0.01, y: 0, z: 0, yaw: 0, moving: false }, AREA);
    for (let i = 1; i <= 20; i++) {
      mc.enqueue({ dx: 1, dz: 0, yaw: 0, run: true, seq: i });
      mc.step();
    }
    assert.ok(mc.current.x <= AREA.maxX);
  });

  it('puxa de volta quem sustenta velocidade acima do teto', () => {
    let t = 0;
    const mc = new MovementController({ ...SPAWN }, AREA, () => t);

    // Flood contínuo: o atacante enfileira muito mais intents do que o tick
    // consome e, em rajadas, ganha terreno que nenhuma checagem por tick vê.
    let seq = 0;
    for (let tick = 0; tick < 30; tick++) {
      for (let i = 0; i < 6; i++) mc.enqueue({ dx: 0, dz: 1, yaw: 0, run: true, seq: ++seq });
      t += FIXED_DT * 1000;
      mc.step();
    }

    const elapsedSec = t / 1000;
    // +janela: o crédito em voo da última auditoria ainda não foi cobrado.
    const ceiling = MAX_SPEED.run * MAX_SPEED.tolerance * (elapsedSec + SPEED_AUDIT_WINDOW_MS / 1000 + FIXED_DT);
    assert.ok(mc.current.z <= ceiling + 1e-6,
      `andou ${mc.current.z.toFixed(2)} m em ${elapsedSec.toFixed(2)} s (teto ${ceiling.toFixed(2)} m)`);
    assert.ok(mc.stats.teleports > 0, 'a auditoria precisa ter acusado');
  });

  it('não acusa quem anda no limite legal', () => {
    let t = 0;
    const mc = new MovementController({ ...SPAWN }, AREA, () => t);
    for (let tick = 1; tick <= 60; tick++) {
      mc.enqueue({ dx: 0, dz: 1, yaw: 0, run: true, seq: tick });
      t += FIXED_DT * 1000;
      mc.step();
    }
    assert.equal(mc.stats.teleports, 0, 'correr honestamente não pode ser punido');
  });

  it('não deixa atravessar a fonte da praça', () => {
    // Anda em linha reta do leste para o centro: a fonte tem que barrar.
    const mc = new MovementController(
      { x: 12, y: 0, z: 0, yaw: 0, moving: false },
      PLAY_AREA.central_plaza,
      () => 0,
      SCENE_COLLIDERS.central_plaza,
      SCENE_AREA.central_plaza ?? null,
    );
    for (let i = 1; i <= 240; i++) {
      mc.enqueue({ dx: -1, dz: 0, yaw: Math.PI / 2, run: true, seq: i });
      mc.step();
    }
    const monument = PLAZA.stairInner + PLAZA.stairSteps * 0.42;
    assert.ok(mc.current.x >= monument + PLAYER_RADIUS - 1e-6,
      `parou em x=${mc.current.x.toFixed(2)}, dentro do monumento (raio ${monument.toFixed(2)})`);
  });

  it('mantém o jogador dentro do disco da praça', () => {
    const mc = new MovementController(
      { x: 0, y: 0, z: 20, yaw: 0, moving: false },
      PLAY_AREA.central_plaza,
      () => 0,
      SCENE_COLLIDERS.central_plaza,
      SCENE_AREA.central_plaza ?? null,
    );
    for (let i = 1; i <= 400; i++) {
      mc.enqueue({ dx: 0, dz: 1, yaw: 0, run: true, seq: i });
      mc.step();
    }
    assert.ok(Math.hypot(mc.current.x, mc.current.z) <= PLAZA.radius + 1e-6,
      `saiu para ${Math.hypot(mc.current.x, mc.current.z).toFixed(2)} m`);
  });

  it('place() força correção no próximo tick', () => {
    const mc = controller();
    mc.place({ x: 5, y: 0, z: 5, yaw: 1, moving: false });
    const out = mc.step();
    assert.equal(out.corrected, true);
    assert.equal(out.pose.x, 5);
  });
});
