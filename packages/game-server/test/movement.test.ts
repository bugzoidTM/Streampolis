import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MovementController, sanitizeIntent, SPEED_AUDIT_WINDOW_MS } from '../src/sim/Movement.js';
import {
  applyMoveIntent, FIXED_DT, FixedStep, INTENT_QUEUE_LIMIT, MAX_CATCHUP_STEPS,
  MAX_FRAME_SECONDS, MAX_INTENTS_PER_TICK, MAX_SPEED, PLAYER_RADIUS, PLAY_AREA,
  PLAZA, SCENE_AREA, SCENE_COLLIDERS, SCENE_SPAWNS, TICK_HZ,
  penetrates, resolveCollision, type Collider, type SceneId,
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

/**
 * O relógio que decide QUANTOS passos cabem num quadro.
 *
 * Estes casos existem porque o defeito que eles trancam não aparecia em
 * captura nenhuma: o avatar parava com a tecla apertada. A causa era o tempo do
 * quadro ser cortado em 50 ms antes de virar passo, então todo quadro mais
 * longo que isso rendia um passo só — e um passo é 1/24 de segundo.
 */
describe('FixedStep', () => {
  it('um segundo de tempo real dá um segundo de passos, seja qual for o quadro', () => {
    for (const fps of [15, 24, 30, 60, 144]) {
      const clock = new FixedStep();
      let steps = 0;
      for (let i = 0; i < fps; i++) steps += clock.advance(1 / fps);
      assert.ok(Math.abs(steps - TICK_HZ) <= 1,
        `a ${fps} qps saíram ${steps} passos, e um segundo tem ${TICK_HZ}`);
    }
  });

  it('engasgo de um quadro é recuperado, não descartado', () => {
    const clock = new FixedStep();
    // 250 ms num quadro só: é o engasgo de uma compilação de shader.
    assert.equal(clock.advance(0.25), 6);
  });

  it('aba em segundo plano não devolve a caminhada inteira', () => {
    const clock = new FixedStep();
    assert.equal(clock.advance(30), MAX_CATCHUP_STEPS);
    // E a dívida não fica guardada para a rajada seguinte.
    assert.equal(clock.advance(1 / 60), 0);
  });

  it('a rajada máxima cabe na fila do servidor', () => {
    // O teto de recuperação não é um número escolhido à toa: é o que o
    // servidor engole. Se algum dos dois lados mudar sem o outro, o jogador
    // que se recupera de um engasgo bate no guarda de enxurrada — que é o
    // mesmo travamento por outro caminho.
    assert.ok(MAX_CATCHUP_STEPS <= INTENT_QUEUE_LIMIT - MAX_INTENTS_PER_TICK,
      'uma rajada de recuperação encheria a fila de intenções');
    assert.equal(MAX_FRAME_SECONDS, (MAX_CATCHUP_STEPS / TICK_HZ));
  });

  it('o servidor drena a rajada de um engasgo sem recusar nada', () => {
    const mc = controller();
    const clock = new FixedStep();
    let seq = 0;
    let sent = 0;
    let refused = 0;
    // Dez quadros de 250 ms — 2,5 s de tecla apertada a 4 quadros por segundo.
    for (let frame = 0; frame < 10; frame++) {
      const steps = clock.advance(0.25);
      for (let i = 0; i < steps; i++) {
        sent++;
        if (mc.enqueue({ dx: 0, dz: 1, yaw: 0, run: false, seq: ++seq })) refused++;
      }
      // O servidor tiquetaqueia enquanto o quadro seguinte não vem.
      for (let t = 0; t < steps; t++) mc.step();
    }
    assert.equal(refused, 0, `o servidor recusou ${refused} de ${sent} intenções`);
    assert.ok(Math.abs(mc.current.z - sent * MAX_SPEED.walk * FIXED_DT) < 1e-6);
  });
});

/**
 * O poço: dois obstáculos cuja folga não cabe num corpo.
 *
 * Uma cadeira encostada na mesa é o caso de todo dia. As duas saídas do
 * resolvedor se anulam — a mesa empurra para fora, a cadeira empurra de volta
 * — e o ponto resolvido é ele mesmo, DENTRO da mesa. Quem cai ali não sai por
 * direção nenhuma, e o servidor não discorda de nada, porque para ele o corpo
 * está exatamente onde ele o pôs. Era este o "às vezes o avatar trava".
 */
describe('resolveCollision: poço entre dois obstáculos', () => {
  const mesa: Collider = { kind: 'rect', x: 0, z: -0.4, hw: 0.9, hd: 0.36, ry: 0 };
  const cadeira: Collider = { kind: 'circle', x: 0, z: 0.4, r: 0.32 };
  const moveis = [mesa, cadeira];

  it('existe, e o resolvedor sozinho não sai dele', () => {
    const poco = resolveCollision({ x: 0, z: 0 }, moveis, null);
    assert.ok(penetrates(poco, moveis), 'o ponto resolvido deveria estar dentro da mesa');
    const outra = resolveCollision(poco, moveis, null);
    assert.ok(Math.hypot(outra.x - poco.x, outra.z - poco.z) < 1e-9,
      'e resolver de novo devolve o mesmo ponto — é um ponto fixo, não um empurrão');
  });

  it('mas o passo que cairia nele não acontece', () => {
    const de = { x: 0, z: 1.4 };
    const saida = resolveCollision({ x: 0, z: 0 }, moveis, null, PLAYER_RADIUS, de);
    assert.deepEqual(saida, de, 'o corpo tem de ficar onde estava');
  });

  it('e quem JÁ está dentro não sai andando — por isso a sala desencalha', () => {
    // Recusar o passo protege quem está de fora; não liberta quem já está
    // dentro, e nenhuma conta de empurrão liberta: as duas saídas continuam se
    // anulando a cada passo. Só se entra num poço destes por um caminho que
    // não é o movimento — o dono redecorando em cima de quem está na sala —, e
    // é lá que a sala devolve o jogador ao ponto de chegada
    // (`BaseWorldRoom.refreshColliders`).
    const preso = resolveCollision({ x: 0, z: 0 }, moveis, null);
    for (let d = 0; d < 8; d++) {
      const ang = (d / 8) * Math.PI * 2;
      const passo = { x: preso.x + Math.cos(ang) * 0.1, z: preso.z + Math.sin(ang) * 0.1 };
      const saida = resolveCollision(passo, moveis, null, PLAYER_RADIUS, preso);
      assert.ok(penetrates(saida, moveis), `a direção ${d} teria saído sozinha do poço`);
    }
  });
});

describe('andar pelas salas não prende ninguém', () => {
  /** Anda `ticks` passos numa direção e devolve a pose final. */
  function caminhada(scene: SceneId, from: { x: number; z: number }, ang: number, ticks = 72) {
    const colliders = SCENE_COLLIDERS[scene];
    const area = SCENE_AREA[scene] ?? null;
    const bounds = PLAY_AREA[scene];
    let pose = { x: from.x, z: from.z, yaw: 0, moving: false };
    let dentro = false;
    for (let i = 0; i < ticks; i++) {
      const next = applyMoveIntent(pose, { dx: Math.cos(ang), dz: Math.sin(ang), yaw: 0, run: false, seq: i + 1 }, bounds);
      const solved = resolveCollision(next, colliders, area, PLAYER_RADIUS, pose);
      pose = { x: solved.x, z: solved.z, yaw: next.yaw, moving: next.moving };
      if (penetrates(pose, colliders)) dentro = true;
    }
    return { pose, dentro };
  }

  const salas: SceneId[] = ['apartment', 'live_room', 'residential_lobby', 'stream_store', 'agency_tower', 'central_plaza'];

  it('sai de toda chegada em toda direção sem entrar num móvel', () => {
    for (const scene of salas) {
      for (const spawn of SCENE_SPAWNS[scene] ?? []) {
        for (let d = 0; d < 16; d++) {
          const { dentro } = caminhada(scene, spawn, (d / 16) * Math.PI * 2);
          assert.equal(dentro, false,
            `${scene}: andando de (${spawn.x}, ${spawn.z}) na direção ${d} o corpo entrou num obstáculo`);
        }
      }
    }
  });

  it('e volta a andar depois de bater em tudo', () => {
    // Ir contra um canto por três segundos e depois virar as costas: se o corpo
    // ficou preso, a volta não anda.
    for (const scene of salas) {
      const spawn = (SCENE_SPAWNS[scene] ?? [])[0];
      if (!spawn) continue;
      for (let d = 0; d < 8; d++) {
        const ang = (d / 8) * Math.PI * 2;
        const { pose } = caminhada(scene, spawn, ang);
        const volta = caminhada(scene, pose, ang + Math.PI, 24);
        const andou = Math.hypot(volta.pose.x - pose.x, volta.pose.z - pose.z);
        assert.ok(andou > 0.5,
          `${scene}: depois de encostar no obstáculo da direção ${d}, a volta andou só ${andou.toFixed(2)} m`);
      }
    }
  });
});

/**
 * O DESENCALHE: o que a sala precisa para libertar quem caiu num poço.
 *
 * A regra da sala é a conjunção de duas coisas, e nenhuma delas sozinha serve:
 * pedir para andar sem sair do lugar (barato de medir, e acontece com quem
 * encosta numa parede) E estar dentro de um bloqueador (caro de medir, e é o
 * que separa "empurrando a parede" de "preso dentro do sofá").
 */
describe('encalhe: o relógio que a sala consulta', () => {
  const mesa: Collider = { kind: 'rect', x: 0, z: -0.4, hw: 0.9, hd: 0.36, ry: 0 };
  const cadeira: Collider = { kind: 'circle', x: 0, z: 0.4, r: 0.32 };

  /** Um controlador com relógio na mão, para não esperar um segundo e meio de verdade. */
  function comRelogio(colliders: Collider[], spawn = { x: 0, y: 0, z: 0, yaw: 0, moving: false }) {
    let agora = 1_000;
    const mc = new MovementController(spawn, AREA, () => agora, colliders, null);
    return { mc, avanca: (ms: number) => { agora += ms; } };
  }

  it('não corre para quem anda', () => {
    const { mc } = comRelogio([]);
    for (let i = 1; i <= 24; i++) { mc.enqueue({ dx: 0, dz: 1, yaw: 0, run: false, seq: i }); mc.step(); }
    assert.equal(mc.stuckFor, 0);
  });

  it('corre para quem empurra a parede — e isso NÃO é encalhe', () => {
    // Encostado no monumento da praça, empurrando contra ele. O relógio corre,
    // mas o corpo não está DENTRO de nada: a sala não faz nada.
    const monumento: Collider = { kind: 'circle', x: 0, z: 0, r: 2 };
    const { mc, avanca } = comRelogio([monumento], { x: 2.5, y: 0, z: 0, yaw: 0, moving: false });
    for (let i = 1; i <= 40; i++) {
      mc.enqueue({ dx: -1, dz: 0, yaw: 0, run: false, seq: i });
      mc.step();
      avanca(42);
    }
    assert.ok(mc.stuckFor > 1_000, 'o relógio precisa correr para quem empurra sem sair do lugar');
    assert.equal(penetrates(mc.current, [monumento]), false,
      'mas empurrar uma parede não é estar dentro dela — e é isso que impede o teleporte à toa');
  });

  it('e quem cai num poço quase sempre SAI empurrando — o desencalhe é raro', () => {
    // Esta era a hipótese: caiu no poço, ficou preso para sempre. É falsa, e é
    // bom que seja — o teste existe para não voltarmos a acreditar nela. De
    // dentro da mesa, empurrando para o lado, o resolvedor cospe o corpo para
    // fora em UM passo. O que não sai é o corpo que está num poço cercado por
    // todos os lados, e é só para ele que a sala teleporta.
    const poco = resolveCollision({ x: 0, z: 0 }, [mesa, cadeira], null);
    assert.ok(penetrates(poco, [mesa, cadeira]), 'o poço tem de ser um poço');
    const { mc, avanca } = comRelogio([mesa, cadeira], { x: poco.x, y: 0, z: poco.z, yaw: 0, moving: false });
    for (let i = 1; i <= 6; i++) {
      mc.enqueue({ dx: 1, dz: 0, yaw: 0, run: false, seq: i });
      mc.step();
      avanca(42);
    }
    assert.equal(penetrates(mc.current, [mesa, cadeira]), false, 'saiu empurrando para o lado');
    assert.equal(mc.stuckFor, 0, 'e o relógio do encalhe nem chegou a correr');
  });

  it('e o relógio zera quando a sala tira o corpo de lá', () => {
    const monumento: Collider = { kind: 'circle', x: 0, z: 0, r: 2 };
    const { mc, avanca } = comRelogio([monumento], { x: 2.5, y: 0, z: 0, yaw: 0, moving: false });
    for (let i = 1; i <= 60; i++) {
      mc.enqueue({ dx: -1, dz: 0, yaw: 0, run: false, seq: i });
      mc.step();
      avanca(42);
    }
    assert.ok(mc.stuckFor > 1_500);
    mc.place({ x: 8, y: 0, z: 8, yaw: 0, moving: false });
    assert.equal(mc.stuckFor, 0, 'depois do desencalhe o relógio recomeça do zero');
  });
});
