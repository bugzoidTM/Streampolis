import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fold, isAddressed, sanitizeSay } from '../src/brain.js';
import { parseJsonObject } from '../src/llm.js';
import { checkInvariants, type Persona } from '../src/persona.js';
import { internalUrlBuilder } from '../src/world.js';
import { Walker, plazaDestinations } from '../src/walker.js';
import { SCENE_COLLIDERS, penetrates } from '../src/shared.js';

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
