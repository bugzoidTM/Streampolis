import { PLAZA } from './layout.js';
import { HOME_BOUNDS, INTERIORS, type Fixture, type SceneLayout } from './interiors.js';
import { PLACEABLES, placementFits, type HomePlacement } from './placeables.js';
import type { SceneId } from './types.js';

/**
 * Walkable space, shared by both authorities.
 *
 * The server decides where a player may stand (SPECs §21) and the client has
 * to predict the same answer, or every bench in the plaza becomes a rubber
 * band. So the solver and the collider tables live here and both sides call
 * the same function — the client to predict, the server to decide.
 */

export interface RectCollider { kind: 'rect'; x: number; z: number; hw: number; hd: number; ry: number }
export interface CircleCollider { kind: 'circle'; x: number; z: number; r: number }
export type Collider = RectCollider | CircleCollider;

export type Area =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'rect'; x: number; z: number; hw: number; hd: number };

export const PLAYER_RADIUS = 0.28;

export interface Point2 { x: number; z: number }

/**
 * Pushes `to` out of every blocker and back inside the area.
 *
 * Two passes, because escaping one collider can push a player into its
 * neighbour — a bench next to a planter would otherwise let you tunnel in the
 * gap. Two is enough for the box-and-cylinder world of the MVP and cheap
 * enough to run per player per tick.
 */
export function resolveCollision(
  to: Point2,
  colliders: readonly Collider[],
  area: Area | null,
  radius = PLAYER_RADIUS,
): Point2 {
  let x = to.x;
  let z = to.z;

  for (let pass = 0; pass < 2; pass++) {
    for (const c of colliders) {
      if (c.kind === 'circle') {
        const dx = x - c.x;
        const dz = z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.r + radius;
        if (d >= min) continue;
        if (d < 1e-4) { x = c.x + min; continue; }
        x = c.x + (dx / d) * min;
        z = c.z + (dz / d) * min;
      } else {
        const cos = Math.cos(-c.ry);
        const sin = Math.sin(-c.ry);
        const rx = (x - c.x) * cos - (z - c.z) * sin;
        const rz = (x - c.x) * sin + (z - c.z) * cos;
        const hw = c.hw + radius;
        const hd = c.hd + radius;
        if (Math.abs(rx) >= hw || Math.abs(rz) >= hd) continue;
        // Escape along the shortest axis: pushing out of the long side is what
        // makes a player slide along a wall instead of being flung around it.
        const px = hw - Math.abs(rx);
        const pz = hd - Math.abs(rz);
        let nx = rx;
        let nz = rz;
        if (px < pz) nx = Math.sign(rx || 1) * hw;
        else nz = Math.sign(rz || 1) * hd;
        const bc = Math.cos(c.ry);
        const bs = Math.sin(c.ry);
        x = c.x + nx * bc - nz * bs;
        z = c.z + nx * bs + nz * bc;
      }
    }
  }

  if (area) {
    if (area.kind === 'circle') {
      const dx = x - area.x;
      const dz = z - area.z;
      const d = Math.hypot(dx, dz);
      const max = area.r - radius;
      if (d > max && d > 1e-4) {
        x = area.x + (dx / d) * max;
        z = area.z + (dz / d) * max;
      }
    } else {
      x = Math.min(Math.max(x, area.x - area.hw + radius), area.x + area.hw - radius);
      z = Math.min(Math.max(z, area.z - area.hd + radius), area.z + area.hd - radius);
    }
  }

  return { x, z };
}

function plazaColliders(): Collider[] {
  const out: Collider[] = [];

  // The monument is one cylinder: the steps are decorative, and standing on
  // step two would need real ground height, which flat-world movement has not.
  out.push({ kind: 'circle', x: 0, z: 0, r: PLAZA.stairInner + PLAZA.stairSteps * 0.42 });

  for (const b of PLAZA.benches) out.push({ kind: 'rect', x: b.x, z: b.z, hw: 0.9, hd: 0.35, ry: b.ry });
  for (const p of PLAZA.planters) out.push({ kind: 'rect', x: p.x, z: p.z, hw: 0.85, hd: 0.85, ry: p.ry });
  for (const k of PLAZA.kiosks) out.push({ kind: 'rect', x: k.x, z: k.z, hw: k.width / 2, hd: k.depth / 2, ry: k.ry });
  for (const t of PLAZA.trees) out.push({ kind: 'circle', x: t.x, z: t.z, r: 0.42 });
  for (const b of PLAZA.bins) out.push({ kind: 'circle', x: b.x, z: b.z, r: 0.32 });
  for (const l of PLAZA.lamps) out.push({ kind: 'circle', x: l.x, z: l.z, r: 0.22 });

  const s = PLAZA.screen;
  out.push({ kind: 'rect', x: s.x, z: s.z, hw: s.width / 2 + 0.4, hd: 1.2, ry: 0 });

  for (const b of PLAZA.buildings) {
    out.push({ kind: 'rect', x: b.x, z: b.z, hw: b.width / 2, hd: b.depth / 2, ry: b.ry });
  }
  return out;
}

/**
 * Blockers a room's own walls contribute. Doorways are not carved out: an
 * opening you can walk through needs a gap in the collider run, and the four
 * segments below are what produce it — the shell builder in the client reads
 * the same openings, so the hole in the geometry and the hole in the collision
 * are the same hole.
 */
function shellColliders(layout: SceneLayout): Collider[] {
  const { width, depth, wall, openings } = layout.shell;
  const hw = width / 2;
  const hd = depth / 2;
  const out: Collider[] = [];

  const runs = (
    side: 'north' | 'south' | 'east' | 'west', span: number,
  ): Array<[number, number]> => {
    // Walk the wall from one end to the other, skipping any opening a player
    // could fit through. A window sill above the floor still blocks.
    const gaps = openings
      .filter((o) => o.side === side && o.y < 0.6)
      .map((o) => [o.x - o.w / 2, o.x + o.w / 2] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const segments: Array<[number, number]> = [];
    let cursor = -span / 2;
    for (const [a, b] of gaps) {
      if (a > cursor) segments.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < span / 2) segments.push([cursor, span / 2]);
    return segments;
  };

  for (const [a, b] of runs('north', width)) {
    out.push({ kind: 'rect', x: (a + b) / 2, z: -hd - wall / 2, hw: (b - a) / 2, hd: wall / 2, ry: 0 });
  }
  for (const [a, b] of runs('south', width)) {
    out.push({ kind: 'rect', x: (a + b) / 2, z: hd + wall / 2, hw: (b - a) / 2, hd: wall / 2, ry: 0 });
  }
  for (const [a, b] of runs('west', depth)) {
    out.push({ kind: 'rect', x: -hw - wall / 2, z: (a + b) / 2, hw: wall / 2, hd: (b - a) / 2, ry: 0 });
  }
  for (const [a, b] of runs('east', depth)) {
    out.push({ kind: 'rect', x: hw + wall / 2, z: (a + b) / 2, hw: wall / 2, hd: (b - a) / 2, ry: 0 });
  }
  return out;
}

/** A fixture blocks only if it declares how much of the floor it takes. */
function fixtureCollider(f: Fixture): Collider | null {
  if (f.r !== undefined) return { kind: 'circle', x: f.x, z: f.z, r: f.r };
  if (f.hw !== undefined && f.hd !== undefined) {
    return { kind: 'rect', x: f.x, z: f.z, hw: f.hw, hd: f.hd, ry: f.ry ?? 0 };
  }
  return null;
}

function interiorColliders(layout: SceneLayout): Collider[] {
  const out = shellColliders(layout);
  for (const f of layout.fixtures) {
    const c = fixtureCollider(f);
    if (c) out.push(c);
  }
  return out;
}

function interior(id: SceneId): Collider[] {
  const layout = INTERIORS[id];
  return layout ? interiorColliders(layout) : [];
}

/** Blockers per scene. Empty means "only the area limit applies". */
export const SCENE_COLLIDERS: Record<SceneId, readonly Collider[]> = {
  central_plaza: plazaColliders(),
  residential_lobby: interior('residential_lobby'),
  apartment: interior('apartment'),
  stream_store: interior('stream_store'),
  agency_tower: interior('agency_tower'),
  pk_arena: interior('pk_arena'),
  live_room: interior('live_room'),
};

/**
 * Walkable limit per scene. The plaza is a disc; every room is the rectangle
 * its own shell describes, which is tighter than the PLAY_AREA envelope the
 * protocol declares — the envelope is a sanity ceiling, this is the floor plan.
 */
function interiorArea(id: SceneId): Area | undefined {
  const layout = INTERIORS[id];
  if (!layout) return undefined;
  return {
    kind: 'rect',
    x: 0,
    z: 0,
    hw: layout.shell.width / 2,
    hd: layout.shell.depth / 2,
  };
}

export const SCENE_AREA: Partial<Record<SceneId, Area>> = {
  central_plaza: { kind: 'circle', x: 0, z: 0, r: PLAZA.radius },
  apartment: interiorArea('apartment'),
  live_room: interiorArea('live_room'),
  pk_arena: interiorArea('pk_arena'),
  residential_lobby: interiorArea('residential_lobby'),
  stream_store: interiorArea('stream_store'),
  agency_tower: interiorArea('agency_tower'),
};

/**
 * Blockers a DECORATED room contributes, on top of its layout's own.
 *
 * Mora aqui, e não na cena, porque a mobília que o jogador colocou é chão
 * ocupado igual à que veio com a planta — e três lados precisam da mesma
 * resposta: a sala (que decide), o preditor do cliente (que prevê) e a cena
 * (que desenha e resolve o modo offline). Enquanto esta conta existia só
 * dentro de `InteriorScene`, o servidor não sabia do sofá do jogador e o
 * apartamento decorado era um cômodo vazio para quem andava nele.
 *
 * Tapete e quadro continuam atravessáveis: só o que declara `hw` E fica no
 * CHÃO ocupa espaço. A meia-volta ímpar troca as meias-extensões, exatamente
 * como em `placementFits` — se as duas contas divergirem, o servidor recusa
 * uma colocação que ele mesmo desenha.
 *
 * Peça que não cabe na sala não vira obstáculo. Isso não é zelo: as medidas
 * que valeram até agora deixavam arrastar um sofá para DENTRO da parede leste
 * (ver `HOME_BOUNDS`), e um caroço dentro da parede não é chão ocupado, é
 * armadilha. O filtro mora AQUI, e não em quem chama, porque servidor, preditor
 * e cena precisam descartar exatamente as mesmas peças — um filtro copiado é o
 * mesmo desencontro que esta função existe para acabar.
 */
export function placementColliders(list: readonly HomePlacement[]): Collider[] {
  const out: Collider[] = [];
  for (const p of list) {
    const def = PLACEABLES[p.itemId];
    if (!def || def.hw === undefined || def.mount !== 'floor') continue;
    if (!placementFits(p, HOME_BOUNDS)) continue;
    const even = p.turn % 2 === 0;
    out.push({
      kind: 'rect',
      x: p.x,
      z: p.z,
      hw: even ? def.hw : (def.hd ?? def.hw),
      hd: even ? (def.hd ?? def.hw) : def.hw,
      ry: 0,
    });
  }
  return out;
}

/**
 * Spawn markers per scene, in one place because two authorities need them: the
 * server assigns a spawn on join and the client predicts from the same point.
 * The plaza's golden-angle ring is generated; rooms get hand-placed markers,
 * because "somewhere on a circle" puts a player inside the kitchen counter.
 */
export interface SpawnPoint { x: number; z: number; yaw: number }

function plazaSpawns(): SpawnPoint[] {
  const out: SpawnPoint[] = [];
  for (let i = 0; i < 12; i++) {
    const a = i * 2.399963229728653; // ~137.5°, spreads sequential joins evenly
    const x = Math.cos(a) * 6;
    const z = Math.sin(a) * 6;
    out.push({ x, z, yaw: Math.atan2(-x, -z) });
  }
  return out;
}

function interiorSpawns(id: SceneId): SpawnPoint[] {
  const layout = INTERIORS[id];
  if (!layout) return [{ x: 0, z: 0, yaw: 0 }];
  return layout.spawns.map((s) => ({
    x: s.x,
    z: s.z,
    // Facing the middle of the room by default: arriving with your back to
    // everything is the fastest way to make a room feel empty.
    yaw: s.yaw ?? Math.atan2(-s.x, -s.z),
  }));
}

export const SCENE_SPAWNS: Record<SceneId, readonly SpawnPoint[]> = {
  central_plaza: plazaSpawns(),
  residential_lobby: interiorSpawns('residential_lobby'),
  apartment: interiorSpawns('apartment'),
  stream_store: interiorSpawns('stream_store'),
  agency_tower: interiorSpawns('agency_tower'),
  pk_arena: interiorSpawns('pk_arena'),
  live_room: interiorSpawns('live_room'),
};
