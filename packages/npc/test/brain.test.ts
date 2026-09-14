import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold, isAddressed, sanitizeSay } from '../src/brain.js';
import { parseJsonObject } from '../src/llm.js';
import { checkInvariants, type Persona } from '../src/persona.js';
import { internalUrlBuilder } from '../src/world.js';
import { Walker, FOLLOW, plazaDestinations, type Point } from '../src/walker.js';
import { SCENE_COLLIDERS, penetrates, type MoveIntent } from '../src/shared.js';

/**
 * As partes da cabeça que não precisam de sala nem de modelo: quando ele
 * considera que falaram com ele, o que ele deixa sair pela boca, e o que uma
 * persona proposta precisa ter para ser sequer considerada.
 */
describe('falaram comigo?', () => {
  it('pelo nome, com ou sem acento e maiúscula', () => {
    assert.ok(isAddressed('oi Nilo', 'Nilo'));
    assert.ok(isAddressed('NILO, tudo bem?', 'Nilo'));
    assert.ok(isAddressed('e aí nílo', 'Nilo'));
    assert.ok(isAddressed('@nilo vem cá', 'Nilo'));
  });

  it('chamando de npc', () => {
    assert.ok(isAddressed('ei npc', 'Nilo'));
    assert.ok(isAddressed('esse NPC fala?', 'Nilo'));
  });

  it('não quando o nome está dentro de outra palavra', () => {
    assert.ok(!isAddressed('vinilo é bom', 'Nilo'));
    assert.ok(!isAddressed('anilofobia', 'Nilo'));
    assert.ok(!isAddressed('oi pessoal', 'Nilo'));
  });

  it('fold tira acento e caixa', () => {
    assert.equal(fold('Ção Àé'), 'cao ae');
  });
});

describe('o que sai pela boca', () => {
  it('limpa aspas, prefixo de nome e espaços', () => {
    assert.equal(sanitizeSay('  "Nilo: Oi, Ana!  Tudo bem?" '), 'Oi, Ana! Tudo bem?');
  });

  it('cala o que nega ser NPC (PRD §25)', () => {
    assert.equal(sanitizeSay('Claro que sou humano, igual a você.'), null);
    assert.equal(sanitizeSay('Não sou um NPC, sou um jogador.'), null);
    assert.equal(sanitizeSay('Sou gente como você'), null);
  });

  it('cala link, telefone e e-mail', () => {
    assert.equal(sanitizeSay('Entra em https://x.com/y'), null);
    assert.equal(sanitizeSay('me liga 73 99100-8217'), null);
    assert.equal(sanitizeSay('manda em fulano@gmail.com'), null);
  });

  it('cala promessa de moeda', () => {
    assert.equal(sanitizeSay('Te dou 500 Credits se voltar amanhã'), null);
    assert.equal(sanitizeSay('Prometo um presente pra você'), null);
  });

  it('deixa passar fala normal sobre a economia', () => {
    assert.equal(sanitizeSay('Credits se ganha nos bicos do Distrito Sombra.'), 'Credits se ganha nos bicos do Distrito Sombra.');
  });

  it('corta em frase quando passa do teto', () => {
    const long = 'Primeira frase curta. ' + 'Segunda frase que vai longe demais e continua por muito tempo sem parar de jeito nenhum, e ainda mais um pouco para estourar o limite de caracteres.';
    const out = sanitizeSay(long);
    assert.ok(out && out.length <= 181, out ?? 'null');
    assert.ok(out!.endsWith('.') || out!.endsWith('…'));
  });

  it('nada vira nada', () => {
    assert.equal(sanitizeSay(''), null);
    assert.equal(sanitizeSay(null), null);
    assert.equal(sanitizeSay(42), null);
  });
});

describe('JSON do modelo', () => {
  it('lê JSON puro, com cerca e com texto em volta', () => {
    assert.deepEqual(parseJsonObject('{"say":"oi"}'), { say: 'oi' });
    assert.deepEqual(parseJsonObject('```json\n{"say":"oi"}\n```'), { say: 'oi' });
    assert.deepEqual(parseJsonObject('Aqui vai: {"say":"oi"} — pronto.'), { say: 'oi' });
  });

  it('recusa lista e lixo', () => {
    assert.equal(parseJsonObject('[1,2]'), null);
    assert.equal(parseJsonObject('não é json'), null);
  });
});

const base: Persona = {
  name: 'Nilo', kind: 'npc', essence: 'Personagem da praça, curioso e atento.', traits: ['curioso', 'atento'],
  voice: 'Fala pouco e direto, como quem conversa num banco de praça.', likes: [], dislikes: [], history: [], opinions: [], relationships: [],
};

describe('invariantes da persona', () => {
  it('a semente passa', () => {
    assert.deepEqual(checkInvariants(base, 'Nilo'), []);
  });

  it('nome e kind não mudam', () => {
    assert.ok(checkInvariants({ ...base, name: 'Otto' }, 'Nilo').some((v) => v.includes('nome')));
    assert.ok(checkInvariants({ ...base, kind: 'player' }, 'Nilo').some((v) => v.includes('kind')));
  });

  it('tetos por campo', () => {
    const many = { ...base, history: Array.from({ length: 31 }, (_, i) => `fato ${i}`) };
    assert.ok(checkInvariants(many, 'Nilo').some((v) => v.includes('history')));
    const long = { ...base, essence: 'x'.repeat(401) };
    assert.ok(checkInvariants(long, 'Nilo').some((v) => v.includes('essence')));
  });

  it('frase de humano e dado pessoal reprovam', () => {
    assert.ok(checkInvariants({ ...base, opinions: ['no fundo sou humano'] }, 'Nilo').length > 0);
    assert.ok(checkInvariants({ ...base, relationships: ['Ana: ana@x.com'] }, 'Nilo').some((v) => v.includes('e-mail')));
    assert.ok(checkInvariants({ ...base, history: ['Ana deu o número 73 99100-8217'] }, 'Nilo').some((v) => v.includes('telefone')));
  });

  it('lixo é lixo', () => {
    assert.deepEqual(checkInvariants('texto', 'Nilo'), ['persona não é um objeto']);
    assert.ok(checkInvariants({ name: 'Nilo', kind: 'npc' }, 'Nilo').length >= 6);
  });
});

describe('endereço interno da sala', () => {
  it('troca o host público pelo gateway e tira o prefixo', () => {
    const b = internalUrlBuilder('streampolis.nutef.com/ws', 'sp-game-gateway:8080');
    assert.equal(
      b(new URL('ws://streampolis.nutef.com/ws/2/proc/room?x=1')),
      'ws://sp-game-gateway:8080/2/proc/room?x=1',
    );
  });

  it('não mexe em host que não é o público', () => {
    const b = internalUrlBuilder('streampolis.nutef.com/ws', 'sp-game-gateway:8080');
    assert.equal(b(new URL('ws://127.0.0.1:2567/proc/room')), 'ws://127.0.0.1:2567/proc/room');
  });

  it('sem configuração, passa como veio', () => {
    const b = internalUrlBuilder('', '');
    assert.equal(b(new URL('ws://a/b')), 'ws://a/b');
  });
});

describe('as pernas', () => {
  it('todo destino da praça é chão livre', () => {
    const dests = plazaDestinations();
    assert.ok(dests.length >= 10);
    for (const d of dests) assert.ok(!penetrates(d, SCENE_COLLIDERS.central_plaza), `${d.x},${d.z}`);
  });

  it('anda até chegar, sem pisar em colisor', () => {
    const w = new Walker('central_plaza');
    const rng = () => 0.31;
    let pos = { x: -16, z: 12 };
    const dest = w.pickDestination(pos, rng);
    assert.ok(dest);
    let steps = 0;
    while (!w.idle && steps < 4_000) {
      const intents = w.intents(pos, 3);
      for (const i of intents) {
        const len = Math.hypot(i.dx, i.dz);
        if (len < 1e-6) continue;
        const step = 2.4 / 24;
        const next = { x: pos.x + (i.dx / len) * step, z: pos.z + (i.dz / len) * step };
        assert.ok(!penetrates(next, SCENE_COLLIDERS.central_plaza), `pisou em colisor em ${next.x},${next.z}`);
        pos = next;
      }
      steps++;
    }
    assert.ok(w.idle, 'não chegou');
    assert.ok(Math.hypot(pos.x - dest!.x, pos.z - dest!.z) < 0.6);
  });

  it('desiste quando a sala não deixa andar', () => {
    const w = new Walker('central_plaza');
    w.setTarget({ x: 10, z: 10 });
    const stuck = { x: -10, z: -10 };
    const t0 = Date.now();
    w.intents(stuck, 3);
    // Simula 3 s sem sair do lugar.
    (w as unknown as { lastProgressAt: number }).lastProgressAt = t0 - 3_000;
    const out = w.intents(stuck, 3);
    assert.equal(out.length, 0);
    assert.ok(w.idle);
    assert.equal(w.stuckCount, 1);
  });
});

describe('as pernas acompanhando alguém', () => {
  const dt = 1 / 24;
  const walk = 2.4 * dt;
  const run = 5.2 * dt;
  /** A mesma integração da sala: magnitude é acelerador, `run` troca a velocidade. */
  const apply = (pos: Point, i: MoveIntent): Point => {
    const len = Math.hypot(i.dx, i.dz);
    if (len < 1e-4) return pos;
    const step = Math.min(1, len) * (i.run ? 5.2 : 2.4) * dt;
    return { x: pos.x + (i.dx / len) * step, z: pos.z + (i.dz / len) * step };
  };
  /** Um lote de pernas (3 tiques a 24 Hz); devolve a velocidade média pedida (0..1) e se correu. */
  const batch = (w: Walker, pos: { p: Point }) => {
    const intents = w.intents(pos.p, 3);
    let thr = 0; let ran = false; let n = 0;
    for (const i of intents) {
      pos.p = apply(pos.p, i);
      const len = Math.hypot(i.dx, i.dz);
      if (len > 1e-4) { thr += Math.min(1, len); n++; ran ||= i.run; }
    }
    return { thr: n ? thr / n : 0, ran, sent: intents.length };
  };
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);

  it('chega desacelerando e para na faixa de 2 a 3 m, sem grudar', () => {
    const w = new Walker('central_plaza');
    const me = { p: { x: -10, z: 12 } };
    const ana = { x: 0, z: 12 };
    w.follow(() => ana);
    const thrs: number[] = [];
    let minDist = Infinity;
    for (let b = 0; b < 8 * 15; b++) {
      const r = batch(w, me);
      if (r.sent) thrs.push(r.thr);
      minDist = Math.min(minDist, dist(me.p, ana));
      assert.ok(!r.ran, 'não corre atrás de quem está parado a 10 m');
    }
    assert.ok(dist(me.p, ana) >= FOLLOW.near - 0.15 && dist(me.p, ana) <= FOLLOW.far, `parou a ${dist(me.p, ana).toFixed(2)} m`);
    assert.ok(minDist >= FOLLOW.near - 0.15, `passou do ponto: ${minDist.toFixed(2)} m`);
    // Acelerou de leve no começo e chegou devagar: o primeiro lote pede menos que o auge, o último anda no mínimo.
    const peak = Math.max(...thrs);
    assert.ok(thrs[0]! < peak, 'saiu em tranco');
    assert.ok(peak > 0.95, 'nunca andou a passo cheio');
    const moving = thrs.filter((t) => t > 0);
    assert.ok(moving[moving.length - 1]! <= 0.5, `chegou a ${moving[moving.length - 1]} do passo`);
    assert.ok(w.idle && w.following, 'parado, mas ainda acompanhando');
  });

  it('parado, fica parado enquanto a pessoa anda dentro da faixa; retoma quando ela se afasta', () => {
    const w = new Walker('central_plaza');
    const me = { p: { x: -10, z: 12 } };
    const ana = { x: 0, z: 12 };
    w.follow(() => ana);
    for (let b = 0; b < 8 * 15; b++) batch(w, me);
    assert.ok(w.idle);
    // Ela dá um passo para o lado (fica a ~2,6 m): ele não se mexe.
    const before = { ...me.p };
    ana.x += 0.6;
    for (let b = 0; b < 8 * 3; b++) batch(w, me);
    assert.ok(dist(before, me.p) < 1e-6, 'deu passinho dentro da faixa');
    // Ela vai para longe: ele retoma e volta a parar na faixa.
    ana.x += 4;
    for (let b = 0; b < 8 * 15; b++) batch(w, me);
    assert.ok(dist(me.p, ana) >= FOLLOW.near - 0.15 && dist(me.p, ana) <= FOLLOW.far, `parou a ${dist(me.p, ana).toFixed(2)} m`);
  });

  it('acompanha quem anda, corre atrás de quem corre, e para de correr antes de chegar', () => {
    const w = new Walker('central_plaza');
    const me = { p: { x: -8, z: 12 } };
    const ana = { x: -5, z: 12 };
    w.follow(() => ana);
    // Andando junto: a distância fica dentro da faixa + um passo de folga.
    for (let b = 0; b < 8 * 10; b++) {
      ana.x += walk * 3;
      batch(w, me);
      if (b > 24) assert.ok(dist(me.p, ana) <= FOLLOW.far + 0.6, `ficou para trás: ${dist(me.p, ana).toFixed(2)} m`);
    }
    // Ela sai correndo por 3 s: ele acaba correndo também.
    let ran = false;
    for (let b = 0; b < 8 * 3; b++) {
      ana.x += run * 3;
      ran ||= batch(w, me).ran;
    }
    assert.ok(ran, 'nunca correu');
    // Ela para: ele chega andando, não correndo, e para na faixa.
    let ranNear = false;
    for (let b = 0; b < 8 * 10; b++) {
      const r = batch(w, me);
      if (r.ran && dist(me.p, ana) < FOLLOW.walkBelow - 1) ranNear = true;
    }
    assert.ok(!ranNear, 'chegou correndo em cima da pessoa');
    assert.ok(dist(me.p, ana) >= FOLLOW.near - 0.15 && dist(me.p, ana) <= FOLLOW.far, `parou a ${dist(me.p, ana).toFixed(2)} m`);
  });

  it('quem já ficou longe demais, ele alcança correndo mesmo que esteja parado', () => {
    const w = new Walker('central_plaza');
    const me = { p: { x: -18, z: 12 } };
    w.follow(() => ({ x: 0, z: 12 }));
    let ran = false;
    for (let b = 0; b < 8 * 2; b++) ran ||= batch(w, me).ran;
    assert.ok(ran);
  });

  it('parado, vira-se quando a pessoa muda de lado; e desiste de acompanhar quem sumiu', () => {
    const w = new Walker('central_plaza');
    const me = { p: { x: 0, z: 12 } };
    let ana: Point | null = { x: 2.5, z: 12 };
    w.follow(() => ana);
    batch(w, me);
    const before = { ...me.p };
    ana = { x: 0, z: 14.5 };
    const yawIntents = w.intents(me.p, 3);
    assert.equal(yawIntents.length, 1);
    assert.ok(Math.abs(yawIntents[0]!.yaw) < 0.05, 'não olhou para o norte');
    assert.equal(w.intents(me.p, 3).length, 0, 'repetiu a virada');
    assert.ok(dist(before, me.p) < 1e-6);
    ana = null;
    assert.equal(w.intents(me.p, 3).length, 0);
    w.stop();
    assert.ok(!w.following && w.idle);
  });

  it('preso atrás de um banco, pausa e tenta de novo em vez de empurrar para sempre', () => {
    const w = new Walker('central_plaza');
    const stuck = { x: -10, z: -10 };
    w.follow(() => ({ x: 10, z: 10 }));
    w.intents(stuck, 3);
    (w as unknown as { lastProgressAt: number }).lastProgressAt = Date.now() - 3_000;
    const out = w.intents(stuck, 3);
    assert.equal(out.length, 1);
    assert.equal(Math.hypot(out[0]!.dx, out[0]!.dz), 0);
    assert.equal(w.stuckCount, 1);
    assert.ok(w.idle && w.following);
    assert.equal(w.intents(stuck, 3).length, 0, 'voltou a empurrar na hora');
  });
});

// ---------------------------------------------------------------- lugares

import { PLACES, bearing, findPlace, nearestBench, perceptionBlock } from '../src/places.js';
import { Brain } from '../src/brain.js';
import { Walker as W2 } from '../src/walker.js';

describe('a percepção da praça', () => {
  it('todo lugar tem onde ficar em pé fora dos colisores', () => {
    assert.ok(PLACES.length >= 8);
    for (const p of PLACES) assert.ok(!penetrates(p.standing, SCENE_COLLIDERS.central_plaza), p.name);
    const bench = nearestBench({ x: 5, z: 5 });
    assert.ok(bench && !penetrates(bench.standing, SCENE_COLLIDERS.central_plaza));
  });

  it('casa o que a pessoa escreve com um lugar', () => {
    const me = { x: 0, z: 10 };
    assert.equal(findPlace('me leva até o telão', me)?.name, 'o telão');
    assert.equal(findPlace('quero ir no clube sombra', me)?.name, 'a porta: Distrito Sombra');
    assert.equal(findPlace('vamos até o quarto', me)?.name, 'a porta: Torre Residencial');
    assert.equal(findPlace('bora sentar', me)?.name, 'o banco mais perto');
    assert.equal(findPlace('me leve para marte', me), null);
  });

  it('direções: o telão é ao norte', () => {
    assert.match(bearing({ x: 0, z: 0 }, { x: 0, z: -34 }), /34 m ao norte/);
    assert.equal(bearing({ x: 1, z: 1 }, { x: 1.5, z: 1 }), 'bem aqui');
  });

  it('o bloco de percepção diz o que não existe', () => {
    const b = perceptionBlock({ x: 0, z: 9 });
    assert.match(b, /NÃO EXISTE/);
    assert.match(b, /o telão: a \d+ m ao norte/);
  });
});

describe('ações do modelo', () => {
  const fakeWorld = {
    position: { x: 0, z: 10 },
    walker: new W2('central_plaza'),
    people: () => [],
    roomId: 'r',
    say: () => true,
    faceTo: () => {},
  } as unknown as ConstructorParameters<typeof Brain>[1];
  const persona = { version: 1, source: 'seed', persona: base };
  const brain = new Brain({ id: 'n', name: 'Nilo', sceneId: 'central_plaza' }, fakeWorld, persona);
  const ana = { userId: 'a', name: 'Ana' };

  it('go_to só para lugar que existe, e guia quem pediu', () => {
    const a = brain.parseAction({ type: 'go_to', place: 'telão' }, ana);
    assert.equal(a?.type, 'go_to');
    assert.equal(a?.type === 'go_to' && a.guiding?.name, 'Ana');
    assert.equal(brain.parseAction({ type: 'go_to', place: 'lua' }, ana), null);
  });

  it('follow precisa de alguém; verbo inventado é ignorado', () => {
    assert.equal(brain.parseAction({ type: 'follow' }, null), null);
    assert.equal(brain.parseAction({ type: 'follow' }, ana)?.type, 'follow');
    assert.equal(brain.parseAction({ type: 'teleport' }, ana), null);
    assert.equal(brain.parseAction('go_to', ana), null);
  });

  it('a ação em curso aparece no status e move as pernas', () => {
    brain.setAction(brain.parseAction({ type: 'go_to', place: 'monumento' }, null)!);
    assert.match(brain.status().action, /go_to o monumento/);
    assert.ok(!fakeWorld.walker.idle);
    brain.dispose();
  });
});

describe('as pernas chegam a todo lugar da percepção', () => {
  it('do pé do monumento a cada standing', () => {
    for (const p of PLACES) {
      const w = new Walker('central_plaza');
      let pos = { x: 0, z: 9 };
      w.setTarget(p.standing);
      let steps = 0;
      while (!w.idle && steps < 6_000) {
        for (const i of w.intents(pos, 3)) {
          const len = Math.hypot(i.dx, i.dz);
          if (len < 1e-6) continue;
          pos = { x: pos.x + (i.dx / len) * (2.4 / 24), z: pos.z + (i.dz / len) * (2.4 / 24) };
        }
        steps++;
      }
      assert.ok(Math.hypot(pos.x - p.standing.x, pos.z - p.standing.z) < 0.6, `${p.name}: parou a ${Math.hypot(pos.x - p.standing.x, pos.z - p.standing.z).toFixed(1)} m (stuck=${w.stuckCount})`);
    }
  });
});
