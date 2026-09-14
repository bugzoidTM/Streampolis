import { placesOf } from './places.js';
import { isFree, nearestFree } from './scenes.js';
import { INTERIORS, PLAZA, PORTALS, type AnimState, type SceneId } from './shared.js';
import type { Point } from './walker.js';

/**
 * Pontos de interesse de uma cena, por CATEGORIA — o que orienta a rotina de
 * um personagem sem tocar na geometria:
 *
 *   social    onde se para para conversar (lados dos quiosques, bordas da pista)
 *   rest      onde se senta ou se encosta (bancos, sombra, lounge do clube)
 *   service   balcão com fila (frente dos quiosques, bar do clube)
 *   landmark  o que se olha (monumento, telão; a pista, no clube)
 *   transit   por onde se passa (portas, bocas de rua, travessias)
 *
 * Cada ponto tem VAGAS (onde ficar em pé, para onde olhar), já conferidas
 * contra a planta; `service` traz a fila (cabeça, direção, espaçamento); o
 * telão traz vagas em duas filas ESCALONADAS a 11 e 14,5 m, para ninguém
 * ficar na frente de ninguém. Tudo aqui é leitura da planta existente.
 */
export type PoiKind = 'social' | 'rest' | 'service' | 'landmark' | 'transit';

export interface Spot { at: Point; yaw: number }

export interface Poi {
  id: string;
  kind: PoiKind;
  sceneId: SceneId;
  /** Onde o ponto É (para "olhar para"). */
  at: Point;
  spots: Spot[];
  covered: boolean;
  /** Vaga de sentar de verdade (o corpo faz o gesto `sit`). */
  seat?: boolean;
  /** Postura ao chegar (a pista do clube: dançar). */
  pose?: AnimState;
  /** Fila (service): cabeça, direção de crescimento, espaçamento, teto. */
  queue?: { head: Point; dir: Point; spacing: number; max: number; faceYaw: number };
  /** Permanência típica em segundos [min, max]. */
  dwell: [number, number];
  /**
   * Para um marco que se olha de um lado só (o telão é um plano): a direção
   * do marco para quem olha. Com ela, "na frente de alguém" é medido ao longo
   * do plano, não da linha até o centro. Sem ela (monumento), vale a radial.
   */
  viewDir?: Point;
}

const cache = new Map<SceneId, Poi[]>();
const yawTo = (from: Point, to: Point) => Math.atan2(to.x - from.x, to.z - from.z);
const unit = (p: Point) => { const r = Math.hypot(p.x, p.z) || 1; return { x: p.x / r, z: p.z / r }; };

function plazaPois(): Poi[] {
  const id: SceneId = 'central_plaza';
  const out: Poi[] = [];
  const center = { x: 0, z: 0 };

  // Quiosques: frente = fila (service, coberta na cabeça pelo toldo); lados = conversa (social).
  PLAZA.kiosks.forEach((k, i) => {
    const u = unit(k);
    const inward = (d: number) => ({ x: k.x - u.x * d, z: k.z - u.z * d });
    const side = (d: number, s: number) => ({ x: k.x - u.x * d + (-u.z) * s, z: k.z - u.z * d + u.x * s });
    const head = nearestFree(id, inward(2.2));
    out.push({
      id: `kiosk:${i}`, kind: 'service', sceneId: id, at: { x: k.x, z: k.z }, covered: true, dwell: [6, 15],
      spots: [{ at: head, yaw: yawTo(head, k) }],
      queue: { head, dir: { x: -u.x, z: -u.z }, spacing: 0.85, max: 4, faceYaw: yawTo(head, k) },
    });
    out.push({
      id: `kiosk:${i}:side`, kind: 'social', sceneId: id, at: { x: k.x, z: k.z }, covered: true, dwell: [30, 90],
      spots: [side(2.3, 1.3), side(2.3, -1.3), side(3.4, 1.9), side(3.4, -1.9)].map((p) => nearestFree(id, p)).map((p) => ({ at: p, yaw: yawTo(p, center) })),
    });
  });

  // Monumento: um anel de vagas a 9,5 m olhando para o centro.
  out.push({
    id: 'monument', kind: 'landmark', sceneId: id, at: center, covered: false, dwell: [30, 90],
    spots: Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2 + 0.2;
      const p = nearestFree(id, { x: Math.cos(a) * 9.6, z: Math.sin(a) * 9.6 });
      return { at: p, yaw: yawTo(p, center) };
    }),
  });

  // Telão: duas filas ESCALONADAS, a 11 e 14,5 m da tela, olhando para ela.
  // A da frente tem vão entre as vagas onde a de trás enxerga: ninguém fica na
  // frente de ninguém, e a clareira dos 9 m fica livre para quem chega.
  const screen = { x: PLAZA.screen.x, z: PLAZA.screen.z };
  const rows: Array<[number, number[]]> = [[11, [-6, -3, 0, 3, 6]], [14.5, [-4.5, -1.5, 1.5, 4.5]]];
  out.push({
    id: 'telao', kind: 'landmark', sceneId: id, at: screen, covered: false, dwell: [30, 90], viewDir: { x: 0, z: 1 },
    spots: rows.flatMap(([dz, xs]) => xs.map((dx) => {
      const p = nearestFree(id, { x: screen.x + dx, z: screen.z + dz });
      return { at: p, yaw: yawTo(p, screen) };
    })),
  });

  // Bancos: as vagas de sentar (rest, sentado de verdade) ficam em `seats.ts`;
  // aqui entra a sombra do anel de árvores como descanso em pé.
  const shade: Spot[] = [];
  for (const t of PLAZA.trees) {
    const r = Math.hypot(t.x, t.z);
    if (r < 1e-6 || r > PLAZA.radius - 3) continue;
    const k = (r - 1.1) / r;
    const p = nearestFree(id, { x: t.x * k, z: t.z * k });
    shade.push({ at: p, yaw: yawTo(p, center) });
  }
  out.push({ id: 'shade', kind: 'rest', sceneId: id, at: center, covered: true, dwell: [40, 120], spots: shade });

  // Portas e bocas de rua: trânsito (a marquise da porta é coberta).
  for (const portal of PORTALS[id] ?? []) {
    const u = unit(portal);
    const p = nearestFree(id, { x: portal.x - u.x * 3.2, z: portal.z - u.z * 3.2 });
    out.push({ id: `door:${portal.id}`, kind: 'transit', sceneId: id, at: { x: portal.x, z: portal.z }, covered: true, dwell: [3, 10], spots: [{ at: p, yaw: yawTo(p, portal) }] });
  }
  // Travessias: os trajetos dos figurantes autorais, como pontos de passagem.
  const cross: Spot[] = [];
  for (const r of PLAZA.crowd) if (r.kind === 'walk') for (const w of r.path) cross.push({ at: nearestFree(id, { x: w.x, z: w.z }), yaw: 0 });
  out.push({ id: 'crossing', kind: 'transit', sceneId: id, at: center, covered: false, dwell: [2, 6], spots: cross });
  return out.map(validated);
}

function clubPois(): Poi[] {
  const id: SceneId = 'noir_club';
  const out: Poi[] = [];
  const dj = { x: 0, z: -10 };
  const floor = { x: 0, z: -1 };
  // A pista: vagas num anel, viradas para o DJ, dançando.
  out.push({
    id: 'club:floor', kind: 'landmark', sceneId: id, at: floor, covered: true, pose: 'dance', dwell: [120, 300],
    spots: Array.from({ length: 14 }, (_, i) => {
      const a = (i / 14) * Math.PI * 2 + 0.3;
      const r = i % 2 ? 2.2 : 4.2;
      const p = nearestFree(id, { x: floor.x + Math.cos(a) * r, z: floor.z + Math.sin(a) * r });
      return { at: p, yaw: yawTo(p, dj) };
    }),
  });
  // O bar, na parede oeste: fila curta encostada aos bancos, de frente para o balcão.
  const layout = INTERIORS.noir_club!;
  const stools = layout.fixtures.filter((f) => f.kind === 'stool' && f.x < -10);
  const barSpots: Spot[] = stools.map((s) => ({ at: nearestFree(id, { x: s.x + 0.8, z: s.z }), yaw: -Math.PI / 2 }));
  out.push({
    id: 'club:bar', kind: 'service', sceneId: id, at: { x: -13, z: -1 }, covered: true, dwell: [20, 50], spots: barSpots,
    queue: { head: barSpots[2]!.at, dir: { x: 1, z: 0 }, spacing: 0.9, max: 3, faceYaw: -Math.PI / 2 },
  });
  // O lounge, na parede leste: sentar de verdade nos sofás e poltronas.
  const lounge: Spot[] = [];
  for (const f of layout.fixtures) {
    if ((f.kind !== 'sofa' && f.kind !== 'armchair') || f.x < 5) continue;
    const ry = f.ry ?? 0;
    const depth = (f.hd ?? 0.45) + 0.37;
    const fx = Math.sin(ry);
    const fz = Math.cos(ry);
    if (f.kind === 'sofa') {
      for (const s of [-0.55, 0.55]) {
        const p = { x: f.x + fx * depth + Math.cos(ry) * s, z: f.z + fz * depth - Math.sin(ry) * s };
        lounge.push({ at: nearestFree(id, p, 0.02), yaw: ry });
      }
    } else {
      lounge.push({ at: nearestFree(id, { x: f.x + fx * depth, z: f.z + fz * depth }, 0.02), yaw: ry });
    }
  }
  out.push({ id: 'club:lounge', kind: 'rest', sceneId: id, at: { x: 10.6, z: -1 }, covered: true, seat: true, dwell: [60, 150], spots: lounge });
  // As bordas da pista: onde se conversa, de frente um para o outro.
  const edges: Spot[] = [];
  for (const [x, z] of [[-7.2, 3.5], [7.2, 3.5], [-8, -4], [8, -4], [0, 7]] as Array<[number, number]>) {
    const a = nearestFree(id, { x: x - 0.6, z });
    const b = nearestFree(id, { x: x + 0.6, z });
    edges.push({ at: a, yaw: yawTo(a, b) }, { at: b, yaw: yawTo(b, a) });
  }
  out.push({ id: 'club:edge', kind: 'social', sceneId: id, at: floor, covered: true, dwell: [40, 120], spots: edges });
  // A porta e o caminho até a pista: trânsito.
  out.push({ id: 'club:door', kind: 'transit', sceneId: id, at: { x: 0, z: 12.4 }, covered: true, dwell: [2, 5], spots: [{ at: nearestFree(id, { x: 0, z: 8.6 }), yaw: Math.PI }, { at: nearestFree(id, { x: 0, z: 4.5 }), yaw: Math.PI }] });
  return out.map(validated);
}

/** Cenas sem tabela própria: as portas como trânsito e os lugares nomeados como marco. */
function genericPois(id: SceneId): Poi[] {
  const out: Poi[] = [];
  for (const portal of PORTALS[id] ?? []) {
    const p = nearestFree(id, { x: portal.x, z: portal.z - 2.5 });
    out.push({ id: `door:${portal.id}`, kind: 'transit', sceneId: id, at: { x: portal.x, z: portal.z }, covered: true, dwell: [2, 6], spots: [{ at: p, yaw: yawTo(p, portal) }] });
  }
  for (const pl of placesOf(id)) {
    if (pl.name.startsWith('a porta')) continue;
    out.push({ id: `place:${pl.name}`, kind: 'landmark', sceneId: id, at: pl.at, covered: false, dwell: [20, 60], spots: [{ at: pl.standing, yaw: yawTo(pl.standing, pl.at) }] });
  }
  return out.map(validated);
}

/** Descarta vagas que não são chão livre: nenhuma rotina nasce dentro de um móvel. */
function validated(p: Poi): Poi {
  return { ...p, spots: p.spots.filter((s) => isFree(p.sceneId, s.at, 0)) };
}

export function poisOf(sceneId: SceneId): Poi[] {
  let list = cache.get(sceneId);
  if (!list) {
    list = (sceneId === 'central_plaza' ? plazaPois() : sceneId === 'noir_club' ? clubPois() : genericPois(sceneId)).filter((p) => p.spots.length > 0);
    cache.set(sceneId, list);
  }
  return list;
}

export function poisOfKind(sceneId: SceneId, kind: PoiKind): Poi[] {
  return poisOf(sceneId).filter((p) => p.kind === kind);
}

export function poiById(sceneId: SceneId, id: string): Poi | undefined {
  return poisOf(sceneId).find((p) => p.id === id);
}

/**
 * Uma vaga livre deste ponto: sem ninguém em cima e, para um marco que se
 * OLHA (telão), sem ninguém logo atrás na mesma linha de visão — parar na
 * frente de quem está assistindo é o que se evita. `bodies` são as posições
 * vivas da sala.
 */
export function freeSpot(poi: Poi, bodies: readonly Point[], rng: () => number, from?: Point): Spot | null {
  const free = poi.spots.filter((s) => !bodies.some((b) => Math.hypot(b.x - s.at.x, b.z - s.at.z) < 0.8));
  const notBlocking = poi.kind === 'landmark'
    ? free.filter((s) => !bodies.some((b) => {
      // Alguém ATRÁS de mim na direção de quem olha, quase na mesma linha: eu taparia.
      const dir = poi.viewDir ?? unit({ x: s.at.x - poi.at.x, z: s.at.z - poi.at.z });
      const vx = b.x - s.at.x;
      const vz = b.z - s.at.z;
      const behind = vx * dir.x + vz * dir.z;
      if (behind < 0.5 || behind > 7) return false;
      const lateral = Math.abs(dir.x * vz - dir.z * vx);
      return lateral < 1.0;
    }))
    : free;
  const pool = notBlocking.length ? notBlocking : free;
  if (!pool.length) return null;
  if (from) {
    // Entre as livres, uma das três mais perto — e não sempre a mais perto.
    const sorted = [...pool].sort((a, b) => Math.hypot(a.at.x - from.x, a.at.z - from.z) - Math.hypot(b.at.x - from.x, b.at.z - from.z));
    return sorted[Math.floor(rng() * Math.min(3, sorted.length))]!;
  }
  return pool[Math.floor(rng() * pool.length)]!;
}
