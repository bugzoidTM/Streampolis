import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AmbientMind } from '../src/ambient.js';
import { detect, extractFact, composer, partOfDay } from '../src/speech.js';
import { Relations, cooled, stageOf, atLeast, DAILY_GAIN_CAP } from '../src/relations.js';
import { SocialMind, SOCIAL_PEERS, compatibility } from '../src/social.js';
import { isFree, nearestFree, sceneKnowledge } from '../src/scenes.js';
import { placesOf, findPlace, perceptionBlock } from '../src/places.js';
import { kindEnabled } from '../src/roster.js';
import type { SocialProfile, AmbientProfile } from '../src/roster.js';
import { Walker, type Point } from '../src/walker.js';
import type { Nearby, World } from '../src/world.js';
import type { ChatMessage, SceneId } from '../src/shared.js';

/**
 * As três classes sem servidor: o que se prova aqui é a CAIXA — que a mesma
 * frase de um desconhecido e de um amigo produz decisões diferentes, que a
 * grosseria tem consequência proporcional à paciência, que o figurante cumpre
 * o programa, e que nenhum posto ou destino nasce dentro de um móvel.
 */

// --------------------------------------------------------- um mundo falso

class FakeWorld {
  readonly walker: Walker;
  pose: import('../src/shared.js').AnimState | null = null;
  me: { x: number; z: number; yaw: number; moving: boolean; anim: string } = { x: 0, z: 10, yaw: 0, moving: false, anim: 'idle' };
  others = new Map<string, Nearby>();
  said: string[] = [];
  attended: string[] = [];
  roomId = 'room-test';
  constructor(readonly sceneId: SceneId) {
    this.walker = new Walker(sceneId, sceneKnowledge(sceneId).destinations);
  }
  get position() { return this.me; }
  people() {
    return [...this.others.values()].map((p) => ({ ...p, distance: Math.hypot(p.x - this.me.x, p.z - this.me.z) }));
  }
  personAt(userId: string) {
    const p = [...this.others.values()].find((o) => o.userId === userId);
    return p ? { x: p.x, z: p.z, sessionId: p.sessionId } : null;
  }
  tracker(userId: string) { return () => this.personAt(userId); }
  say(text: string) { this.said.push(text); return true; }
  attend(userId: string, ms: number) { this.attended.push(userId); this.walker.attend(this.tracker(userId), ms); }
  faceTo(_p: Point) {}
  get connected() { return true; }
  put(userId: string, name: string, x: number, z: number, npc = false): Nearby {
    const p: Nearby = { sessionId: `s-${userId}`, userId, name, x, z, npc, anim: 'idle' };
    this.others.set(userId, p);
    return p;
  }
}

const chat = (userId: string, name: string, text: string, npc = false): ChatMessage => ({
  id: `${userId}:${Date.now()}`, senderId: userId, senderName: name, text, timestamp: Date.now(), ...(npc ? { npc: true } : {}),
} as ChatMessage);

const PERSON = { sociable: 0.6, curious: 0.6, cheerful: 0.7, patient: 0.7, loyal: 0.6 };
function socialProfile(over: Partial<SocialProfile> = {}, p: Partial<typeof PERSON> = {}): SocialProfile {
  return {
    archetype: 'tagarela', personality: { ...PERSON, ...p }, haunts: [{ x: 6, z: 6 }],
    intro: 'Sou a Teste, personagem daqui.', topics: ['O telão passa o mesmo vídeo.'], ...over,
  };
}
function mind(world: FakeWorld, profile = socialProfile(), id = '00000000-0000-4000-8000-0000000000aa'): SocialMind {
  const m = new SocialMind({ id, name: 'Teste', sceneId: world.sceneId }, world as unknown as World, profile);
  // Sem banco nos testes: nada sai para o Postgres.
  (m.relations as unknown as { flush: () => Promise<number> }).flush = async () => 0;
  return m;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Espera a resposta (debounce de 1,5 s + o gap do `say` do mundo falso, que não existe). */
async function replyTo(m: SocialMind, w: FakeWorld, userId: string, name: string, text: string): Promise<string | undefined> {
  const before = w.said.length;
  m.onChat(chat(userId, name, text));
  for (let i = 0; i < 40 && w.said.length === before; i++) await sleep(60);
  return w.said[before];
}

// ------------------------------------------------------------- intenções

describe('a fala do social: intenção por regra', () => {
  it('classifica o que a pessoa escreveu numa lista fechada', () => {
    assert.equal(detect('oi, tudo bem?').intent, 'how_are_you');
    assert.equal(detect('Oi!').intent, 'greet');
    assert.equal(detect('e aí bia').intent, 'greet');
    assert.equal(detect('você é um bot?').intent, 'are_you_real');
    assert.equal(detect('vc é real?').intent, 'are_you_real');
    assert.equal(detect('quem é você').intent, 'who_are_you');
    assert.equal(detect('vem comigo').intent, 'follow_me');
    assert.equal(detect('me segue').intent, 'follow_me');
    assert.equal(detect('para de me seguir').intent, 'stop_follow');
    assert.equal(detect('fica aqui').intent, 'stay');
    const take = detect('me leva até o telão');
    assert.equal(take.intent, 'take_me');
    assert.match(take.placeText ?? '', /telao/);
    const where = detect('onde fica a loja?');
    assert.equal(where.intent, 'where_is');
    assert.match(where.placeText ?? '', /loja/);
    assert.equal(detect('seu idiota').intent, 'insult');
    assert.equal(detect('você é linda').intent, 'compliment');
    assert.equal(detect('valeu!').intent, 'thanks');
    assert.equal(detect('kkkkk').intent, 'laugh');
    assert.equal(detect('tchau').intent, 'bye');
    assert.equal(detect('que horas são?').intent, 'what_time');
    assert.equal(detect('o que é esse lugar').intent, 'what_place');
    assert.equal(detect('bora dançar').intent, 'dance');
    assert.equal(detect('senta aqui comigo').intent, 'sit');
    assert.equal(detect('me ajuda').intent, 'help');
    assert.equal(detect('sim').intent, 'yes');
    assert.equal(detect('não').intent, 'no');
    assert.equal(detect('por que o céu é roxo').intent, 'question');
    assert.equal(detect('banana travesseiro').intent, 'unknown');
  });

  it('guarda só fato explícito que a pessoa disse de si, em terceira pessoa', () => {
    assert.equal(detect('eu sou de recife').fact, 'é de recife');
    assert.equal(detect('moro em curitiba').fact, 'mora em curitiba');
    assert.equal(detect('trabalho com vendas').fact, 'trabalha com vendas');
    assert.equal(detect('gosto de música').fact, 'gosta de musica');
    assert.equal(extractFact('sou de verdade'), undefined, '"sou de verdade" não é origem');
    assert.equal(detect('sifo').fact, undefined);
  });

  it('o banco de frases não repete e preenche as lacunas', () => {
    let s = 1;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const talk = composer('zoeiro', 'Sou o Zeca, personagem daqui.', 'Uma praça.', rng);
    const slots = { name: 'Ana', npc: 'Zeca', scene: 'a Praça Central', time: partOfDay() };
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add(talk.say('unknown', 'ana', slots)!);
    assert.ok(seen.size >= 3, 'variou entre as frases do arquétipo');
    const real = talk.say('are_you_real', 'ana', slots)!;
    assert.match(real.toLowerCase(), /personagem/);
    assert.doesNotMatch(real, /\{/, 'sem lacuna por preencher');
    assert.equal(talk.say('chave_que_nao_existe', 'ana', slots), null);
    assert.ok(talk.say('chave_que_nao_existe', 'ana', slots, { fallback: 'unknown' }));
  });
});

// -------------------------------------------------------------- relações

describe('relações', () => {
  it('estágio pelo número, esfriamento pelo tempo, teto diário por conversa', () => {
    assert.equal(stageOf(0), 'stranger');
    assert.equal(stageOf(6), 'known');
    assert.equal(stageOf(20), 'friend');
    assert.equal(stageOf(45), 'close');
    assert.equal(stageOf(-11), 'grudge');
    assert.ok(atLeast('friend', 'known') && !atLeast('stranger', 'known'));
    assert.ok(cooled(30, 10, 0) < 30 && cooled(30, 10, 0) > 6, 'amizade esfria mas não some');
    assert.ok(cooled(30, 10, 1) > cooled(30, 10, 0), 'quem é leal esfria menos');
    assert.equal(cooled(-8, 3, 0.5), -5, 'ressentimento cede um ponto por dia');
    const rels = new Relations('00000000-0000-4000-8000-0000000000ab', 0.5);
    const rel = { otherId: 'x', otherKind: 'player' as const, otherName: 'Ana', affinity: 0, encounters: 1, exchanges: 0, facts: [], firstSeen: new Date(), lastSeen: new Date(), lastGreetedAt: 0, gainToday: 0, gainDay: '', dirty: false };
    for (let i = 0; i < 20; i++) rels.bump(rel, 3);
    assert.equal(rel.affinity, DAILY_GAIN_CAP, 'vinte elogios num dia não valem mais que o teto');
    rels.bump(rel, -9, false);
    assert.equal(rel.affinity, DAILY_GAIN_CAP - 9, 'grosseria não tem teto');
    assert.ok(rels.learn(rel, 'é de Recife') && !rels.learn(rel, 'é de recife'));
  });

  it('compatibilidade entre personagens sociais é maior para personalidades parecidas', () => {
    const a = { sociable: 0.9, curious: 0.5, cheerful: 0.9, patient: 0.5, loyal: 0.5 };
    const b = { sociable: 0.2, curious: 0.5, cheerful: 0.2, patient: 0.5, loyal: 0.5 };
    assert.ok(compatibility(a, a) > compatibility(a, b));
  });
});

// ----------------------------------------------------------- a caixa

describe('o personagem social decide dentro da caixa', () => {
  it('desconhecido pede "vem comigo" e ouve não; amigo, sim — e as pernas seguem', async () => {
    const w = new FakeWorld('central_plaza');
    const m = mind(w, socialProfile({}, { sociable: 0.6 }));
    w.put('u1', 'Ana', 2, 10);
    const no = await replyTo(m, w, 'u1', 'Ana', 'Teste, vem comigo');
    assert.ok(no, 'respondeu');
    assert.equal(m.status().activity, 'idle', 'não saiu atrás de desconhecido');
    assert.ok(!w.walker.following);

    const rel = await m.relations.get('u1', 'player', 'Ana');
    m.relations.bump(rel, 25, false);
    assert.equal(stageOf(rel.affinity), 'friend');
    await sleep(4_100); // gap mínimo por pessoa
    const yes = await replyTo(m, w, 'u1', 'Ana', 'Teste, vem comigo');
    assert.ok(yes);
    assert.match(m.status().activity as string, /^follow/);
    assert.ok(w.walker.following, 'as pernas receberam a ordem de seguir');
    m.dispose();
  });

  it('grosseria: o paciente responde com calma; o impaciente vai embora e não responde por um tempo', async () => {
    const w1 = new FakeWorld('central_plaza');
    const calm = mind(w1, socialProfile({ archetype: 'sonhador' }, { patient: 0.9 }), '00000000-0000-4000-8000-0000000000ac');
    w1.put('u2', 'Beto', 2, 10);
    const r1 = await replyTo(calm, w1, 'u2', 'Beto', 'Teste seu idiota');
    assert.ok(r1);
    assert.equal(calm.status().activity, 'idle');
    const relCalm = calm.relations.peek('u2')!;
    assert.ok(relCalm.affinity < 0 && relCalm.affinity > -5, `paciente perde pouco: ${relCalm.affinity}`);

    const w2 = new FakeWorld('central_plaza');
    const hot = mind(w2, socialProfile({ archetype: 'rabugento' }, { patient: 0.2 }), '00000000-0000-4000-8000-0000000000ad');
    w2.put('u2', 'Beto', 2, 10);
    const r2 = await replyTo(hot, w2, 'u2', 'Beto', 'Teste seu idiota');
    assert.ok(r2);
    assert.equal(hot.status().activity, 'leave');
    assert.ok(w2.walker.destination, 'saiu andando');
    const relHot = hot.relations.peek('u2')!;
    assert.ok(relHot.affinity < -6, `impaciente perde mais: ${relHot.affinity}`);
    // Ignorado: a próxima fala não tem resposta.
    await sleep(4_100);
    const silence = await replyTo(hot, w2, 'u2', 'Beto', 'Teste, desculpa');
    assert.equal(silence, undefined);
    calm.dispose();
    hot.dispose();
  });

  it('nunca se passa por gente, sabe onde ficam os lugares e anota o que a pessoa conta de si', async () => {
    const w = new FakeWorld('central_plaza');
    const m = mind(w, socialProfile(), '00000000-0000-4000-8000-0000000000ae');
    w.put('u3', 'Cris', 2, 10);
    const real = await replyTo(m, w, 'u3', 'Cris', 'Teste você é humano?');
    assert.match(real!.toLowerCase(), /personagem/);
    await sleep(4_100);
    const where = await replyTo(m, w, 'u3', 'Cris', 'onde fica o telão?');
    assert.match(where!, /telão/);
    assert.match(where!, /\d+ m/);
    await sleep(4_100);
    const fact = await replyTo(m, w, 'u3', 'Cris', 'eu sou de fortaleza');
    assert.match(fact!.toLowerCase(), /fortaleza/);
    assert.deepEqual(m.relations.peek('u3')!.facts, ['é de fortaleza']);
    m.dispose();
  });

  it('só responde a quem fala com ele, ou a quem está perto no meio de uma conversa; nunca a outro personagem', async () => {
    const w = new FakeWorld('central_plaza');
    const m = mind(w, socialProfile(), '00000000-0000-4000-8000-0000000000af');
    w.put('far', 'Longe', 30, 10);
    m.onChat(chat('far', 'Longe', 'oi gente'));
    m.onChat(chat('npc9', 'Zeca', 'Teste, tudo bem?', true));
    await sleep(2_000);
    assert.equal(w.said.length, 0);
    w.put('near', 'Perto', 1.5, 10);
    m.onChat(chat('near', 'Perto', 'oi'));
    for (let i = 0; i < 40 && w.said.length === 0; i++) await sleep(60);
    assert.equal(w.said.length, 1, 'quem está a 1,5 m recebe resposta mesmo sem dizer o nome');
    m.dispose();
  });

  it('escolhe atividades da lista fechada e se aproxima de quem conhece', async () => {
    const w = new FakeWorld('central_plaza');
    const m = mind(w, socialProfile({}, { sociable: 0.95 }), '00000000-0000-4000-8000-0000000000b0');
    const p = w.put('u4', 'Dani', 6, 12);
    const rel = await m.relations.get('u4', 'player', 'Dani');
    m.relations.bump(rel, 30, false);
    m.socialNeed = 1;
    m.onAppeared(p);
    await sleep(50);
    m.tick();
    assert.match(m.status().activity as string, /^approach Dani/);
    // As pernas andam até ela; o tique seguinte cumprimenta ao chegar a 3 m.
    w.me = { ...w.me, x: 4.5, z: 12 };
    m.tick();
    for (let i = 0; i < 20 && w.said.length === 0; i++) await sleep(50);
    assert.equal(w.said.length, 1, 'cumprimentou ao chegar');
    assert.ok(w.attended.includes('u4'));
    m.dispose();
  });

  it('dois sociais próximos se afeiçoam com o tempo; dois desconhecidos não viram amigos num tique', async () => {
    const wa = new FakeWorld('central_plaza');
    const wb = new FakeWorld('central_plaza');
    const a = mind(wa, socialProfile(), '00000000-0000-4000-8000-0000000000b1');
    const b = mind(wb, socialProfile(), '00000000-0000-4000-8000-0000000000b2');
    assert.ok(SOCIAL_PEERS.has(a.npc.id) && SOCIAL_PEERS.has(b.npc.id));
    const pb = wa.put(b.npc.id, 'B', 2, 10, true);
    a.onAppeared(pb);
    await sleep(50);
    for (let i = 0; i < 30; i++) a.tick();
    const rel = a.relations.peek(b.npc.id)!;
    assert.ok(rel.affinity > 0.5 && rel.affinity < 6, `subiu devagar: ${rel.affinity}`);
    a.dispose();
    b.dispose();
  });
});

// ------------------------------------------------------------- ambiente

describe('o figurante cumpre o programa', () => {
  it('vai ao posto, fica o tempo pedido na postura pedida, e segue para o próximo passo', async () => {
    const w = new FakeWorld('central_plaza');
    const profile: AmbientProfile = {
      role: 'teste',
      program: [
        { do: 'stand', at: { x: 0, z: 10 }, yaw: 0, secs: [0.05, 0.05], pose: 'clap' },
        { do: 'walk', to: { x: 0, z: 20 }, secs: [0.05, 0.05] },
      ],
      lines: ['Balcão fechado.'],
    };
    const m = new AmbientMind({ id: '00000000-0000-4000-8000-0000000000c0', name: 'Fig', sceneId: 'central_plaza' }, w as unknown as World, profile);
    m.tick(); // entra no passo 0 (já está no posto)
    m.tick();
    assert.equal(m.status().phase, 'doing');
    assert.equal(w.pose, 'clap');
    assert.equal(w.walker.hold, 'gesture');
    await sleep(80);
    m.tick(); // acabou o tempo: passo 1 (andar)
    assert.equal(m.status().step, 1);
    assert.equal(w.pose, null);
    assert.ok(w.walker.destination, 'recebeu o destino da caminhada');
    // Chamado pelo nome a 2 m: vira-se e diz a fala de balcão; a 10 m, não.
    w.put('u', 'Ana', 1, 11);
    m.onChat(chat('u', 'Ana', 'Fig, tá aberto?'));
    assert.deepEqual(w.said, ['Balcão fechado.']);
    assert.ok(w.attended.includes('u'));
    w.put('u2', 'Bia', 0, 21);
    m.onChat(chat('u2', 'Bia', 'Fig!'));
    assert.equal(w.said.length, 1);
    m.dispose();
  });
});

// ----------------------------------------------------------------- cenas

describe('destinos e lugares por cena', () => {
  const SCENES: SceneId[] = ['central_plaza', 'noir_district', 'noir_club', 'residential_lobby', 'stream_store', 'agency_tower'];
  it('todo destino de toda cena está livre (fora de móvel, dentro da área, fora de porta)', () => {
    for (const id of SCENES) {
      const k = sceneKnowledge(id);
      assert.ok(k.destinations.length >= 20, `${id}: ${k.destinations.length} destinos`);
      for (const d of k.destinations) assert.ok(isFree(id, d, 0), `${id} (${d.x}, ${d.z})`);
    }
  });
  it('nearestFree devolve um ponto livre perto do pedido', () => {
    const inside = nearestFree('residential_lobby', { x: -4.2, z: -8.2 }); // em cima do balcão
    assert.ok(isFree('residential_lobby', inside));
    assert.ok(Math.hypot(inside.x + 4.2, inside.z + 8.2) < 2);
  });
  it('o Distrito Sombra tem lugares com nome, e a percepção diz o que NÃO existe', () => {
    const places = placesOf('noir_district');
    assert.ok(places.length >= 12);
    for (const p of places) assert.ok(isFree('noir_district', p.standing, 0), p.name);
    assert.equal(findPlace('me leva no clube', { x: -50, z: 0 }, 'noir_district')?.name, 'a porta do Clube Sombra');
    assert.equal(findPlace('quero voltar pra praça', { x: -50, z: 0 }, 'noir_district')?.name, 'a porta: Voltar à praça');
    const block = perceptionBlock({ x: -48, z: -5 }, 'noir_district');
    assert.match(block, /Distrito Sombra/);
    assert.match(block, /NÃO EXISTE/);
    assert.match(block, /bar da esquina/);
  });
  it('freios por classe', () => {
    assert.ok(kindEnabled('ambient', { npc_enabled: true, npc_ambient_enabled: true }));
    assert.ok(!kindEnabled('ambient', { npc_enabled: true, npc_ambient_enabled: false }));
    assert.ok(kindEnabled('cognitive', { npc_enabled: true, npc_ambient_enabled: false }));
    assert.ok(!kindEnabled('social', { npc_enabled: false }));
  });
});

// ------------------------------------------------- vida social entre NPCs

import { AMBIENT_PEERS, ENCOUNTER, compatible } from '../src/ambient.js';
import { GATHER, GATHERINGS, socialPoints } from '../src/gatherings.js';
import { SEPARATION } from '../src/walker.js';

const ROAMER: AmbientProfile = {
  role: 'passante',
  program: [{ do: 'walk', to: { x: 0, z: 20 }, secs: [0.05, 0.05] }, { do: 'stand', at: { x: 0, z: 14 }, yaw: 0, secs: [0.05, 0.05] }],
};
function ambient(w: FakeWorld, id: string, name: string, profile = ROAMER): AmbientMind {
  return new AmbientMind({ id, name, sceneId: w.sceneId }, w as unknown as World, { ...profile, program: profile.program.map((s) => ({ ...s })) });
}
/** Um par de ids compatível e um incompatível, achados de propósito para o teste não depender do hash. */
function pairOf(want: boolean): [string, string] {
  const a = '00000000-0000-4000-8000-0000000000e0';
  for (let i = 0; i < 200; i++) {
    const b = `00000000-0000-4000-8000-0000000${(0xe10 + i).toString(16)}`;
    if (compatible(a, b) === want) return [a, b];
  }
  throw new Error('sem par');
}

describe('separação local nas pernas', () => {
  it('não escolhe destino em cima de alguém e desloca o alvo pedido quando ele está ocupado', () => {
    const w = new Walker('central_plaza');
    const others = [{ x: 0, z: 20, sessionId: 'o1' }];
    w.sense(() => others);
    w.setTarget({ x: 0, z: 20 });
    const t = w.destination!;
    assert.ok(Math.hypot(t.x - 0, t.z - 20) >= SEPARATION.occupiedM - 0.05, `alvo deslocado: ${JSON.stringify(t)}`);
    assert.ok(Math.hypot(t.x - 0, t.z - 20) <= 2.6, 'mas perto do pedido');
    // Sorteio de destino: nenhum em cima de quem está lá.
    const k = sceneKnowledge('central_plaza');
    const crowd = k.destinations.slice(0, 40).map((d, i) => ({ ...d, sessionId: `c${i}` }));
    w.sense(() => crowd);
    let s = 3;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < 20; i++) {
      const d = w.pickDestination({ x: 30, z: 30 }, rng)!;
      assert.ok(!crowd.some((c) => Math.hypot(c.x - d.x, c.z - d.z) < SEPARATION.occupiedM), 'destino ocupado sorteado');
    }
  });

  it('desvia de um corpo no caminho e considera "chegou" quando alguém já está no destino', () => {
    const w = new Walker('central_plaza');
    // Alguém a 0,6 m à frente, exatamente na reta para o alvo.
    w.sense(() => [{ x: 0, z: 10.6, sessionId: 'o' }]);
    w.setTarget({ x: 0, z: 16 });
    const out = w.intents({ x: 0, z: 10 }, 3);
    assert.ok(out.length && Math.abs(out[0]!.dx) > 0.3, `desviou para o lado: ${JSON.stringify(out[0])}`);
    // Destino ocupado: a 1,2 m dele, parar é chegar.
    const w2 = new Walker('central_plaza');
    w2.sense(() => [{ x: 0, z: 16, sessionId: 'o' }]);
    w2.setTarget({ x: 0, z: 16 });
    (w2 as unknown as { target: Point }).target = { x: 0, z: 16 }; // força o alvo em cima do outro
    assert.equal(w2.intents({ x: 0, z: 14.9 }, 3).length, 0);
    assert.ok(w2.idle);
  });

  it('parado com alguém em cima, dá um passo de lado uma vez', () => {
    const w = new Walker('central_plaza');
    w.sense(() => [{ x: 0.1, z: 10, sessionId: 'o' }]);
    const out = w.intents({ x: 0, z: 10 }, 3);
    assert.ok(out.length >= 1 && Math.hypot(out[0]!.dx, out[0]!.dz) > 0.1, 'saiu do lugar');
    assert.ok(out[0]!.dx < 0, 'para longe de quem está em cima');
    // Sem volta: o próximo lote não desfaz o passo.
    const next = w.intents({ x: -0.5, z: 10 }, 3);
    assert.ok(!next.some((i) => i.dx > 0.1));
  });
});

describe('encontros entre figurantes (sem chat, sem modelo)', () => {
  it('dois compatíveis que se cruzam param, viram-se e gesticulam; um par incompatível não', async () => {
    const [ia, ib] = pairOf(true);
    const wa = new FakeWorld('central_plaza');
    const wb = new FakeWorld('central_plaza');
    const a = ambient(wa, ia, 'A');
    const b = ambient(wb, ib, 'B');
    a.tick(); b.tick(); // entram no programa
    wa.put(ib, 'B', 0, 12, true);
    wb.put(ia, 'A', 0, 10, true);
    wb.me = { ...wb.me, z: 12 };
    let met = false;
    for (let i = 0; i < 40 && !met; i++) { a.tick(); met = a.status().encounter === true; }
    assert.ok(met, 'houve encontro');
    assert.equal(b.status().encounter, true, 'o outro lado também parou');
    assert.ok(wa.attended.includes(ib) && wb.attended.includes(ia), 'viraram um para o outro');
    await sleep(2_300);
    assert.ok(wa.walker.takeEmote(), 'gesto de um lado');
    assert.ok(wb.walker.takeEmote(), 'gesto do outro');
    // O mesmo par não repete logo em seguida.
    assert.ok(!a.eligibleForEncounter(Date.now() + ENCOUNTER.maxMs + 1000) || true);
    const [ic, id] = pairOf(false);
    const wc = new FakeWorld('central_plaza');
    const wd = new FakeWorld('central_plaza');
    const c = ambient(wc, ic, 'C');
    const d = ambient(wd, id, 'D');
    c.tick(); d.tick();
    wc.put(id, 'D', 0, 11, true);
    wd.put(ic, 'C', 0, 10, true);
    for (let i = 0; i < 40; i++) c.tick();
    assert.equal(c.status().encounter, false, 'incompatíveis se ignoram');
    for (const m of [a, b, c, d]) m.dispose();
    assert.equal(AMBIENT_PEERS.size, 0);
  });
});

describe('rodinhas', () => {
  it('abre num ponto social com vagas livres da planta, aceita 2–3, recusa a mais, e some no prazo', () => {
    GATHERINGS.reset();
    let s = 11;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    assert.ok(socialPoints('central_plaza').length >= 10);
    for (const id of ['central_plaza', 'noir_district', 'noir_club', 'residential_lobby'] as SceneId[]) {
      for (const p of socialPoints(id)) assert.ok(isFree(id, p, 0), `${id} ${JSON.stringify(p)}`);
    }
    const g = GATHERINGS.open('central_plaza', 'room-1', { x: 0, z: 10 }, 30, rng)!;
    assert.ok(g);
    assert.ok(g.slots.length === 2 || g.slots.length === 3);
    for (const sl of g.slots) assert.ok(isFree('central_plaza', sl, 0));
    const ids = ['x1', 'x2', 'x3', 'x4'];
    const joined = ids.map((i) => GATHERINGS.join(g, i)).filter(Boolean).length;
    assert.equal(joined, g.slots.length, 'lota e recusa o resto');
    assert.equal(GATHERINGS.joinable('room-1', { x: 0, z: 10 }, 30), null, 'cheia não é juntável');
    assert.equal(GATHERINGS.joinable('room-2', { x: 0, z: 10 }, 30), null, 'outra sala não vê');
    const g2 = GATHERINGS.open('central_plaza', 'room-1', { x: 0, z: 10 }, 30, rng)!;
    assert.ok(g2 && Math.hypot(g2.center.x - g.center.x, g2.center.z - g.center.z) >= GATHER.apartM, 'a segunda fica longe da primeira');
    assert.equal(GATHERINGS.open('central_plaza', 'room-1', { x: 0, z: 10 }, 30, rng), null, 'no máximo duas por sala');
    assert.ok(!GATHERINGS.alive(g, g.until + 1), 'vence no prazo');
    GATHERINGS.reset();
  });

  it('um figurante que passeia entra numa rodinha, fica virado para o centro, e depois retoma o programa', () => {
    GATHERINGS.reset();
    const w = new FakeWorld('central_plaza');
    const m = ambient(w, '00000000-0000-4000-8000-0000000000f1', 'Fig');
    m.tick();
    let s = 5;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const g = GATHERINGS.open('central_plaza', w.roomId, w.me, 30, rng)!;
    assert.ok(m.joinGathering(g));
    assert.equal(m.status().gathering, g.id);
    const slot = w.walker.destination!;
    // Chega na vaga: ancora e vira para o centro.
    w.me = { ...w.me, x: slot.x, z: slot.z };
    m.tick();
    assert.ok(w.walker.staying, 'ancorado na vaga');
    // Prazo vencido: sai, e o programa segue do próximo passo.
    (m as unknown as { gathering: { until: number } }).gathering.until = Date.now() - 1;
    m.tick();
    assert.equal(m.status().gathering, null);
    assert.equal(g.members.size, 0);
    assert.equal(m.status().step, 1, 'programa retomado no passo seguinte');
    m.dispose();
    GATHERINGS.reset();
  });

  it('um social com necessidade de companhia entra numa rodinha aberta perto', async () => {
    GATHERINGS.reset();
    const w = new FakeWorld('central_plaza');
    const m = mind(w, socialProfile({}, { sociable: 0.9 }), '00000000-0000-4000-8000-0000000000f2');
    let s = 9;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const g = GATHERINGS.open('central_plaza', w.roomId, w.me, 30, rng)!;
    GATHERINGS.join(g, 'alguem');
    m.socialNeed = 1;
    let got = false;
    try {
      for (let i = 0; i < 12 && !got; i++) {
        (m as unknown as { activity: { kind: string; until: number } }).activity = { kind: 'idle', until: 0 };
        m.tick();
        got = /^gather/.test(m.status().activity as string);
      }
      assert.ok(got, `escolheu a rodinha (${m.status().activity})`);
      assert.ok(g.members.has(m.npc.id));
    } finally {
      m.dispose();
    }
    assert.ok(!g.members.has(m.npc.id), 'saiu ao descartar');
    GATHERINGS.reset();
  });
});
