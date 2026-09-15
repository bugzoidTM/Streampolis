import { GATHER, GATHERINGS, type Gathering } from './gatherings.js';
import { findPlace, placesOf, type Place } from './places.js';
import { freeSpot, poiById, poisOfKind, type Poi, type PoiKind, type Spot } from './poi.js';
import { QUEUES } from './queues.js';
import { nearestFree, sceneKnowledge } from './scenes.js';
import { freeSeatNear } from './seats.js';
import type { SceneId } from './shared.js';
import type { Point } from './walker.js';
import type { World } from './world.js';

/**
 * A biblioteca de HABILIDADES do personagem cognitivo.
 *
 * O modelo decide O QUE fazer (um objetivo em texto) e ESCOLHE uma habilidade
 * daqui para fazê-lo; a habilidade é código — uma máquina de estados sobre o
 * corpo (`World`/`Walker`) — e é o que garante que "qualquer ação" continue
 * sendo uma ação que existe. Cada habilidade se descreve para o prompt, valida
 * os parâmetros que o modelo mandou (lugar que existe, gente que está aqui) e
 * roda por tiques até dizer `done`/`failed`, ou até o prazo da intenção.
 *
 * A lista é fechada de propósito e cresce por código, não por prompt: uma
 * habilidade nova é um caso novo aqui, com o corpo já sabendo fazê-la.
 */
export type SkillState = 'running' | 'done' | 'failed';

export interface SkillCtx {
  world: World;
  npc: { id: string; name: string; sceneId: SceneId };
  rng: () => number;
  now: number;
  /** Uma fala curta pela boca dele (já passa pelo sanitizador do cérebro). */
  say(text: string): Promise<boolean>;
  /** Pede um cumprimento a alguém (o cérebro decide se cabe no orçamento). */
  greet(userId: string, name: string): void;
  /** Pede uma reflexão agora (o processo decide se pode). */
  requestReflection(): void;
  /**
   * O corpo chegou a um destino (o `Goer` avisa; `sit`, ao sentar). O cérebro
   * registra na intenção: chegou ou não, em quanto tempo, quanto ficou lá.
   */
  arrived?(at: Point): void;
}

export interface SkillRun {
  tick(ctx: SkillCtx): SkillState;
  stop(ctx: SkillCtx): void;
  /** Uma linha para o status e para o prompt de conversa ("o que você está fazendo"). */
  doing(): string;
}

export interface Skill {
  name: string;
  /** Para o prompt: o que é e que parâmetros aceita. */
  describe(scene: SceneId): string | null;
  /** Normaliza os parâmetros do modelo; nulo = inválido (o plano é recusado). */
  validate(params: Record<string, unknown>, ctx: { scene: SceneId; world: World }): Record<string, unknown> | null;
  start(params: Record<string, unknown>, ctx: SkillCtx): SkillRun;
}

const LINGER_MIN_MS = 6_000;
const LINGER_MAX_MS = 28_000;

function str(v: unknown, max = 64): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Andar até um ponto e esperar chegar; três tentativas antes de desistir. */
class Goer {
  private retries = 0;
  private arrived = false;
  constructor(private readonly target: Point, private readonly tolerance = 1.3) {}
  tick(ctx: SkillCtx): 'going' | 'arrived' | 'failed' {
    const me = ctx.world.position;
    if (!me) return 'going';
    if (this.arrived) return 'arrived';
    if (dist(me, this.target) <= this.tolerance) { this.arrived = true; ctx.arrived?.(this.target); return 'arrived'; }
    const w = ctx.world.walker;
    if (w.idle) {
      if (this.retries++ >= 3) return 'failed';
      w.setTarget(this.target);
    }
    return 'going';
  }
}

// ---------------------------------------------------------------- wander --

const wander: Skill = {
  name: 'wander',
  describe: () => 'wander: passear sem rumo pela cena, parando aqui e ali. Sem parâmetros.',
  validate: () => ({}),
  start: () => {
    let lingerUntil = 0;
    return {
      tick(ctx) {
        const me = ctx.world.position;
        const w = ctx.world.walker;
        if (!me) return 'running';
        if (w.idle && ctx.now > lingerUntil) {
          w.pickDestination(me, ctx.rng);
          lingerUntil = ctx.now + LINGER_MIN_MS + ctx.rng() * (LINGER_MAX_MS - LINGER_MIN_MS);
        }
        return 'running';
      },
      stop(ctx) { ctx.world.walker.release(); },
      doing: () => 'passeando',
    };
  },
};

// ----------------------------------------------------------------- go_to --

const go_to: Skill = {
  name: 'go_to',
  describe: (scene) => `go_to: ir a um lugar da lista e ficar por lá. Parâmetros: {"place": "nome do lugar"}${scene === 'central_plaza' ? '; opcional {"guiding": true} quando alguém está com você e pediu para ser levado' : ''}.`,
  validate: (p, ctx) => {
    const me = ctx.world.position ?? { x: 0, z: 0 };
    const name = str(p.place, 80);
    const place = name ? findPlace(name, me, ctx.scene) : null;
    if (!place) return null;
    const guiding = typeof p.guiding === 'object' && p.guiding !== null ? p.guiding as { userId?: unknown; name?: unknown } : null;
    const who = guiding && typeof guiding.userId === 'string' && typeof guiding.name === 'string' ? { userId: guiding.userId, name: guiding.name } : null;
    return { place: place.name, ...(who ? { guiding: who } : {}) };
  },
  start: (p, ctx) => {
    const place = placesOf(ctx.npc.sceneId).find((x) => x.name === p.place) ?? findPlace(String(p.place), ctx.world.position ?? { x: 0, z: 0 }, ctx.npc.sceneId)!;
    const who = (p.guiding as { userId: string; name: string } | undefined) ?? null;
    const goer = new Goer(place.standing, 1.3);
    let arrived = false;
    // A ordem sai já: quem pediu "me leva" vê o corpo virar e andar no mesmo instante.
    ctx.world.walker.guide(place.standing, who ? ctx.world.tracker(who.userId) : null);
    if (who) ctx.world.guide(who.userId, place.standing);
    return {
      tick(c) {
        const w = c.world.walker;
        if (arrived) return 'running';
        if (who && !c.world.personAt(who.userId)) {
          // Quem era guiado sumiu: segue sozinho.
          c.world.guide(null, null);
          w.guide(place.standing, null);
        }
        const st = goer.tick(c);
        if (st === 'failed') { c.world.guide(null, null); return 'failed'; }
        if (st === 'arrived') {
          arrived = true;
          c.world.guide(null, null);
          w.stayAt(place.standing);
          w.face(place.at, c.world.position ?? place.standing);
        }
        return 'running';
      },
      stop(c) { c.world.guide(null, null); c.world.walker.release(); },
      doing: () => arrived ? `em ${place.name}` : `indo até ${place.name}${who ? `, guiando ${who.name}` : ''}`,
    };
  },
};

// ---------------------------------------------------------------- follow --

const follow: Skill = {
  name: 'follow',
  describe: () => 'follow: acompanhar uma pessoa que está aqui. Parâmetros: {"userId": "...", "name": "..."} — só de quem está falando com você.',
  validate: (p, ctx) => {
    const userId = str(p.userId, 64);
    const name = str(p.name, 32);
    if (!userId || !name || !ctx.world.personAt(userId)) return null;
    return { userId, name };
  },
  start: (p, ctx) => {
    const userId = String(p.userId);
    const name = String(p.name);
    ctx.world.walker.follow(ctx.world.tracker(userId));
    return {
      tick(c) {
        if (!c.world.personAt(userId)) return 'done';
        if (!c.world.walker.following) c.world.walker.follow(c.world.tracker(userId));
        return 'running';
      },
      stop(c) { c.world.walker.release(); },
      doing: () => `seguindo ${name}`,
    };
  },
};

// ------------------------------------------------------------------- sit --

const sit: Skill = {
  name: 'sit',
  describe: (scene) => sceneKnowledge(scene).seats.length ? 'sit: sentar num banco perto (ou perto de alguém). Parâmetros opcionais: {"near": "userId de quem está com você"}.' : null,
  validate: (p, ctx) => {
    if (!sceneKnowledge(ctx.scene).seats.length) return null;
    const near = str(p.near, 64);
    return near && ctx.world.personAt(near) ? { near } : {};
  },
  start: (p, ctx) => {
    const seats = sceneKnowledge(ctx.npc.sceneId).seats;
    const anchor = (p.near ? ctx.world.personAt(String(p.near)) : null) ?? ctx.world.position ?? { x: 0, z: 0 };
    const occupied = ctx.world.people().map((x) => ({ x: x.x, z: x.z }));
    const seat = freeSeatNear(seats, anchor, occupied) ?? freeSeatNear(seats, sceneKnowledge(ctx.npc.sceneId).destinations[0] ?? anchor, occupied);
    let failed = !seat;
    let seatedOnce = false;
    if (seat) ctx.world.walker.sitAt({ at: seat.at, yaw: seat.yaw });
    return {
      tick(c) {
        if (failed) return 'failed';
        const w = c.world.walker;
        if (w.seated) {
          w.hold = 'seated';
          if (!seatedOnce && seat) { seatedOnce = true; c.arrived?.(seat.at); }
          return 'running';
        }
        if (!w.sitting) { failed = true; return 'failed'; }
        return 'running';
      },
      stop(c) { c.world.walker.standUp(); c.world.walker.hold = 'free'; c.world.walker.release(); },
      doing: () => 'sentado num banco',
    };
  },
};

// ------------------------------------------------------------------ stay --

const stay: Skill = {
  name: 'stay',
  describe: () => 'stay: ficar onde está, atento a quem passa. Sem parâmetros.',
  validate: () => ({}),
  start: (_p, ctx) => {
    const me = ctx.world.position;
    if (me) ctx.world.walker.stayAt({ x: me.x, z: me.z });
    return { tick: () => 'running', stop(c) { c.world.walker.release(); }, doing: () => 'parado, olhando o movimento' };
  },
};

// ------------------------------------------------------------------ rest --

const rest: Skill = {
  name: 'rest',
  describe: () => 'rest: descansar num canto tranquilo (sombra, borda), sem puxar conversa. Sem parâmetros.',
  validate: () => ({}),
  start: (_p, ctx) => {
    const pois = [...poisOfKind(ctx.npc.sceneId, 'rest'), ...poisOfKind(ctx.npc.sceneId, 'social')];
    const me = ctx.world.position ?? { x: 0, z: 0 };
    const bodies = ctx.world.people().map((x) => ({ x: x.x, z: x.z }));
    let spot: Spot | null = null;
    for (const poi of pois) { spot = freeSpot(poi, bodies, ctx.rng, me); if (spot) break; }
    const goer = spot ? new Goer(spot.at, 1.0) : null;
    let settled = false;
    return {
      tick(c) {
        if (!goer || !spot) return 'failed';
        if (settled) return 'running';
        const st = goer.tick(c);
        if (st === 'failed') return 'failed';
        if (st === 'arrived') { settled = true; c.world.walker.stayAt(spot.at); c.world.faceTo({ x: spot.at.x + Math.sin(spot.yaw), z: spot.at.z + Math.cos(spot.yaw) }); }
        return 'running';
      },
      stop(c) { c.world.walker.release(); },
      doing: () => 'descansando num canto',
    };
  },
};

// ------------------------------------------------------------ watch_telao --

const watch_telao: Skill = {
  name: 'watch_telao',
  describe: (scene) => poiById(scene, 'telao') ? 'watch_telao: ficar olhando o telão de uma distância boa, sem tapar ninguém. Sem parâmetros.' : null,
  validate: (_p, ctx) => (poiById(ctx.scene, 'telao') ? {} : null),
  start: (_p, ctx) => visitPoiRun(poiById(ctx.npc.sceneId, 'telao')!, ctx, 'olhando o telão'),
};

function visitPoiRun(poi: Poi, ctx: SkillCtx, label: string): SkillRun {
  const me = ctx.world.position ?? { x: 0, z: 0 };
  const bodies = ctx.world.people().map((x) => ({ x: x.x, z: x.z }));
  const spot = freeSpot(poi, bodies, ctx.rng, me);
  const goer = spot ? new Goer(spot.at, 0.9) : null;
  let settled = false;
  return {
    tick(c) {
      if (!goer || !spot) return 'failed';
      if (settled) return 'running';
      const st = goer.tick(c);
      if (st === 'failed') return 'failed';
      if (st === 'arrived') {
        settled = true;
        c.world.walker.stayAt(spot.at);
        c.world.faceTo(poi.at);
        if (poi.pose) { c.world.pose = poi.pose; c.world.walker.hold = 'gesture'; }
      }
      return 'running';
    },
    stop(c) { c.world.pose = null; c.world.walker.hold = 'free'; c.world.walker.release(); },
    doing: () => label,
  };
}

// ----------------------------------------------------------- people_watch --

const people_watch: Skill = {
  name: 'people_watch',
  describe: () => 'people_watch: ficar num ponto de passagem observando quem vai e vem. Parâmetros opcionais: {"place": "nome do lugar"}.',
  validate: (p, ctx) => {
    const name = str(p.place, 80);
    if (!name) return {};
    const place = findPlace(name, ctx.world.position ?? { x: 0, z: 0 }, ctx.scene);
    return place ? { place: place.name } : {};
  },
  start: (p, ctx) => {
    const scene = ctx.npc.sceneId;
    const named = p.place ? placesOf(scene).find((x) => x.name === p.place) : undefined;
    const target: Point | null = named ? named.standing : (() => {
      const pois = [...poisOfKind(scene, 'social'), ...poisOfKind(scene, 'transit')];
      const bodies = ctx.world.people().map((x) => ({ x: x.x, z: x.z }));
      for (const poi of pois.sort(() => ctx.rng() - 0.5)) { const s = freeSpot(poi, bodies, ctx.rng, ctx.world.position ?? undefined); if (s) return s.at; }
      return null;
    })();
    const goer = target ? new Goer(target, 1.1) : null;
    let settled = false;
    return {
      tick(c) {
        if (!goer || !target) return 'failed';
        if (settled) return 'running';
        const st = goer.tick(c);
        if (st === 'failed') return 'failed';
        if (st === 'arrived') { settled = true; c.world.walker.stayAt(target); }
        return 'running';
      },
      stop(c) { c.world.walker.release(); },
      doing: () => named ? `observando o movimento em ${named.name}` : 'observando quem passa',
    };
  },
};

// ---------------------------------------------------------- greet_arrivals --

const greet_arrivals: Skill = {
  name: 'greet_arrivals',
  describe: () => 'greet_arrivals: ficar perto de uma entrada e dar um oi curto a quem chega (gasta uma fala por pessoa). Parâmetros opcionais: {"place": "nome de uma porta"}.',
  validate: (p, ctx) => people_watch.validate(p, ctx),
  start: (p, ctx) => {
    const base = people_watch.start(p, ctx);
    const seen = new Set<string>();
    return {
      tick(c) {
        const st = base.tick(c);
        for (const person of c.world.people()) {
          if (person.npc || person.distance > 7 || seen.has(person.userId)) continue;
          seen.add(person.userId);
          c.greet(person.userId, person.name);
        }
        return st;
      },
      stop: base.stop,
      doing: () => 'recebendo quem chega',
    };
  },
};

// --------------------------------------------------------- join_gathering --

const join_gathering: Skill = {
  name: 'join_gathering',
  describe: () => 'join_gathering: entrar numa rodinha de personagens que já existe (ou abrir uma num ponto social) e ficar por lá. Sem parâmetros.',
  validate: () => ({}),
  start: (_p, ctx) => {
    let g: Gathering | null = null;
    let slot: Point | null = null;
    let goer: Goer | null = null;
    let settled = false;
    const room = ctx.world.roomId ?? '';
    const me = ctx.world.position ?? { x: 0, z: 0 };
    g = GATHERINGS.joinable(room, me, 30) ?? GATHERINGS.open(ctx.npc.sceneId, room, me, 30, ctx.rng);
    if (g) { slot = GATHERINGS.join(g, ctx.npc.id); if (slot) goer = new Goer(slot, 0.9); }
    return {
      tick(c) {
        if (!g || !slot || !goer) return 'failed';
        if (!GATHERINGS.alive(g, c.now)) return 'done';
        if (settled) return 'running';
        const st = goer.tick(c);
        if (st === 'failed') return 'failed';
        if (st === 'arrived') { settled = true; c.world.walker.stayAt(slot); c.world.faceTo(g.center); }
        return 'running';
      },
      stop(c) { if (g) GATHERINGS.leave(g, c.npc.id); c.world.walker.release(); },
      doing: () => 'numa rodinha',
    };
  },
};

// ------------------------------------------------------------ queue_kiosk --

const queue_kiosk: Skill = {
  name: 'queue_kiosk',
  describe: (scene) => poisOfKind(scene, 'service').length ? 'queue_kiosk: entrar na fila curta de um quiosque, esperar a vez e seguir. Parâmetros opcionais: {"kiosk": 0|1|2}.' : null,
  validate: (p, ctx) => {
    const list = poisOfKind(ctx.scene, 'service');
    if (!list.length) return null;
    const k = typeof p.kiosk === 'number' && Number.isInteger(p.kiosk) && p.kiosk >= 0 && p.kiosk < list.length ? p.kiosk : null;
    return k === null ? {} : { kiosk: k };
  },
  start: (p, ctx) => {
    const list = poisOfKind(ctx.npc.sceneId, 'service');
    const poi = list[typeof p.kiosk === 'number' ? p.kiosk : Math.floor(ctx.rng() * list.length)]!;
    const room = ctx.world.roomId ?? '';
    let idx = QUEUES.join(room, poi, ctx.npc.id);
    let goer: Goer | null = idx === null ? null : new Goer(nearestFree(ctx.npc.sceneId, QUEUES.slot(poi, idx)), 0.7);
    let servedUntil = 0;
    let lastIdx = idx ?? -1;
    return {
      tick(c) {
        if (idx === null || !goer) return 'failed';
        const now = QUEUES.indexOf(room, poi, c.npc.id);
        if (now < 0) return 'done';
        if (now !== lastIdx) { lastIdx = now; goer = new Goer(nearestFree(c.npc.sceneId, QUEUES.slot(poi, now)), 0.7); c.world.walker.release(); }
        const st = goer.tick(c);
        if (st === 'failed') return 'failed';
        if (st === 'arrived') {
          c.world.walker.stayAt(nearestFree(c.npc.sceneId, QUEUES.slot(poi, now)));
          c.world.faceTo(poi.at);
          if (now === 0) {
            if (!servedUntil) servedUntil = c.now + 8_000 + c.rng() * 8_000;
            else if (c.now >= servedUntil) return 'done';
          }
        }
        return 'running';
      },
      stop(c) { QUEUES.leave(room, poi, c.npc.id); c.world.walker.release(); },
      doing: () => `na fila do ${poi.id.replace('kiosk:', 'quiosque ')}`,
    };
  },
};

// ---------------------------------------------------------------- patrol --

const patrol: Skill = {
  name: 'patrol',
  describe: () => 'patrol: dar uma volta por dois ou mais lugares da lista, parando um pouco em cada um. Parâmetros: {"places": ["nome", "nome", ...]}.',
  validate: (p, ctx) => {
    if (!Array.isArray(p.places)) return null;
    const me = ctx.world.position ?? { x: 0, z: 0 };
    const names = p.places.map((x) => str(x, 80)).filter((x): x is string => !!x).map((n) => findPlace(n, me, ctx.scene)?.name).filter((n): n is string => !!n);
    return names.length >= 2 ? { places: [...new Set(names)].slice(0, 6) } : null;
  },
  start: (p, ctx) => {
    const places = (p.places as string[]).map((n) => placesOf(ctx.npc.sceneId).find((x) => x.name === n)).filter((x): x is Place => !!x);
    let i = 0;
    let goer = new Goer(places[0]!.standing, 1.3);
    let dwellUntil = 0;
    return {
      tick(c) {
        if (dwellUntil) {
          if (c.now < dwellUntil) return 'running';
          dwellUntil = 0;
          i = (i + 1) % places.length;
          goer = new Goer(places[i]!.standing, 1.3);
          c.world.walker.release();
        }
        const st = goer.tick(c);
        if (st === 'failed') { i = (i + 1) % places.length; goer = new Goer(places[i]!.standing, 1.3); return 'running'; }
        if (st === 'arrived') { dwellUntil = c.now + 20_000 + c.rng() * 25_000; c.world.walker.stayAt(places[i]!.standing); c.world.faceTo(places[i]!.at); }
        return 'running';
      },
      stop(c) { c.world.walker.release(); },
      doing: () => `dando uma volta (agora ${places[i]!.name})`,
    };
  },
};

// ------------------------------------------------------------- visit_poi --

const KINDS: PoiKind[] = ['social', 'rest', 'service', 'landmark', 'transit'];
const visit_poi: Skill = {
  name: 'visit_poi',
  describe: () => 'visit_poi: percorrer pontos de um tipo (social: onde se conversa; rest: onde se descansa; landmark: o que se olha; transit: por onde se passa), um de cada vez. Parâmetros: {"kind": "social|rest|landmark|transit"}.',
  validate: (p, ctx) => {
    const kind = str(p.kind, 16) as PoiKind | null;
    if (!kind || !KINDS.includes(kind) || !poisOfKind(ctx.scene, kind).length) return null;
    return { kind };
  },
  start: (p, ctx) => {
    const kind = p.kind as PoiKind;
    let run: SkillRun | null = null;
    let dwellUntil = 0;
    const next = (c: SkillCtx) => {
      const list = poisOfKind(c.npc.sceneId, kind);
      const poi = list[Math.floor(c.rng() * list.length)]!;
      run = visitPoiRun(poi, c, `visitando ${poi.id}`);
      dwellUntil = 0;
    };
    next(ctx);
    return {
      tick(c) {
        if (!run) return 'failed';
        const st = run.tick(c);
        if (st === 'failed') { run.stop(c); next(c); return 'running'; }
        if (!dwellUntil && run.doing() && c.world.walker.staying) dwellUntil = c.now + 30_000 + c.rng() * 40_000;
        if (dwellUntil && c.now > dwellUntil) { run.stop(c); next(c); }
        return 'running';
      },
      stop(c) { run?.stop(c); },
      doing: () => run?.doing() ?? `visitando pontos (${kind})`,
    };
  },
};

// --------------------------------------------------------------- reflect --

const reflect: Skill = {
  name: 'reflect',
  describe: () => 'reflect: parar num canto e escrever no diário sobre o que viveu (só vale se faz tempo que não escreve). Sem parâmetros.',
  validate: () => ({}),
  start: (_p, ctx) => {
    const base = rest.start({}, ctx);
    let asked = false;
    return {
      tick(c) {
        const st = base.tick(c);
        if (!asked) { asked = true; c.requestReflection(); }
        return st === 'failed' ? 'running' : st;
      },
      stop: base.stop,
      doing: () => 'pensando, escrevendo no diário',
    };
  },
};

export const SKILLS: Record<string, Skill> = {
  wander, go_to, follow, sit, stay, rest, watch_telao, people_watch, greet_arrivals, join_gathering, queue_kiosk, patrol, visit_poi, reflect,
};

/** As habilidades que fazem sentido nesta cena, descritas para o prompt. */
export function describeSkills(scene: SceneId): string[] {
  const out: string[] = [];
  for (const s of Object.values(SKILLS)) {
    if (s.name === 'follow') continue; // só nasce de conversa
    const d = s.describe(scene);
    if (d) out.push(`- ${d}`);
  }
  return out;
}
