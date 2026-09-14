import {
  INTERIORS, NOIR, PLAZA, PLAYER_RADIUS, PORTALS, SCENE_AREA, SCENE_COLLIDERS, penetrates,
  type Collider, type SceneId,
} from './shared.js';
import { sceneSeats, type Seat } from './seats.js';
import { plazaDestinations, type Point } from './walker.js';

/**
 * O que as PERNAS sabem de cada cena: onde dá para ir, onde dá para sentar,
 * e alguns pontos com nome para os postos dos figurantes.
 *
 * Até aqui só a praça tinha isso (`plazaDestinations`, `sceneSeats`), porque
 * só o Nilo existia e ele mora lá. Com personagens em seis cenas, cada uma
 * precisa de destinos que já estejam fora dos colisores — a mesma regra de
 * sempre: um destino dentro de um banco é um personagem preso, e preso é o
 * que um jogador nota primeiro.
 *
 * Os interiores não têm trajetos autorais; os destinos deles são uma grade
 * amostrada dentro do casco, longe das paredes e fora das portas — parar na
 * porta bloqueia quem entra e sai. O Distrito Sombra soma os trajetos dos
 * figurantes, as paradas dos bicos e pontos nas calçadas das duas ruas.
 */
export interface SceneKnowledge {
  id: SceneId;
  /** Como o lugar se chama em prosa ("a Praça Central"). */
  label: string;
  destinations: Point[];
  seats: Seat[];
  colliders: readonly Collider[];
}

export const SCENE_LABEL: Record<SceneId, string> = {
  central_plaza: 'a Praça Central',
  residential_lobby: 'o saguão da Torre Residencial',
  apartment: 'um apartamento',
  stream_store: 'a Stream Store',
  agency_tower: 'a Torre das Agências',
  pk_arena: 'a Arena de PK',
  live_room: 'uma sala de live',
  noir_district: 'o Distrito Sombra',
  noir_club: 'o Clube Sombra',
};

const cache = new Map<SceneId, SceneKnowledge>();

export function sceneKnowledge(id: SceneId): SceneKnowledge {
  let k = cache.get(id);
  if (!k) {
    k = { id, label: SCENE_LABEL[id], destinations: destinationsOf(id), seats: sceneSeats(id), colliders: SCENE_COLLIDERS[id] ?? [] };
    cache.set(id, k);
  }
  return k;
}

/** Ponto livre: fora dos colisores (com folga), dentro da área e fora de porta. */
export function isFree(id: SceneId, p: Point, clearance = 0.15): boolean {
  const colliders = SCENE_COLLIDERS[id] ?? [];
  if (penetrates(p, colliders, PLAYER_RADIUS + clearance)) return false;
  if (!insideArea(id, p, PLAYER_RADIUS + clearance)) return false;
  for (const portal of PORTALS[id] ?? []) {
    if (Math.hypot(portal.x - p.x, portal.z - p.z) < portal.r + 0.6) return false;
  }
  return true;
}

export function insideArea(id: SceneId, p: Point, margin = PLAYER_RADIUS): boolean {
  const area = SCENE_AREA[id];
  if (!area) return true;
  if (area.kind === 'circle') return Math.hypot(p.x - area.x, p.z - area.z) <= area.r - margin;
  return Math.abs(p.x - area.x) <= area.hw - margin && Math.abs(p.z - area.z) <= area.hd - margin;
}

/**
 * O ponto livre mais perto de `p` (busca em espiral, passo de 0,3 m, até 4 m).
 * Serve para um posto escrito à mão que caiu por um triz dentro de um móvel —
 * e para o dado do banco nunca deixar um corpo nascer preso.
 */
export function nearestFree(id: SceneId, p: Point, clearance = 0.15): Point {
  if (isFree(id, p, clearance)) return p;
  for (let r = 0.1; r <= 4.0; r += 0.1) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
      if (isFree(id, q, clearance)) return q;
    }
  }
  return p;
}

/** Folga de um posto: quem senta "num sofá" fica encostado nele; o resto guarda 15 cm. */
export function clearanceFor(pose: string | undefined): number {
  return pose === 'sit' ? 0.02 : 0.15;
}

function gridInside(id: SceneId, x0: number, x1: number, z0: number, z1: number, step: number): Point[] {
  const out: Point[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += step) {
    for (let z = z0; z <= z1 + 1e-6; z += step) {
      const p = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 };
      if (isFree(id, p, 0.35)) out.push(p);
    }
  }
  return out;
}

function interiorDestinations(id: SceneId): Point[] {
  const layout = INTERIORS[id];
  if (!layout) return [];
  const hw = layout.shell.width / 2 - 1.2;
  const hd = layout.shell.depth / 2 - 1.2;
  return gridInside(id, -hw, hw, -hd, hd, 1.5);
}

function noirDestinations(): Point[] {
  const out: Point[] = [];
  const id: SceneId = 'noir_district';
  for (const r of NOIR.crowd) for (const w of r.path) out.push({ x: w.x, z: w.z });
  for (const s of Object.values(NOIR.stops)) out.push({ x: s.x, z: s.z });
  // Calçadas da avenida e da travessa: é por onde se anda de madrugada.
  for (let x = -52; x <= 52; x += 5) {
    out.push({ x, z: -(NOIR.streetHalf - 1.7) });
    out.push({ x, z: NOIR.streetHalf - 1.7 });
  }
  for (let x = -36; x <= 36; x += 5) {
    out.push({ x, z: NOIR.laneZ - (NOIR.laneHalf - 1.4) });
    out.push({ x, z: NOIR.laneZ + (NOIR.laneHalf - 1.4) });
  }
  // O beco e as duas passagens, para quem atravessa.
  out.push({ x: 7, z: -13 }, { x: 6.8, z: -16.5 }, { x: -24, z: -15 }, { x: -24, z: -27 }, { x: 33, z: -15 }, { x: 33, z: -27 });
  return dedupe(out.filter((p) => isFree(id, p, 0.2)));
}

function dedupe(points: Point[]): Point[] {
  const seen = new Set<string>();
  return points.filter((p) => {
    const k = `${p.x.toFixed(1)}:${p.z.toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function destinationsOf(id: SceneId): Point[] {
  switch (id) {
    case 'central_plaza': {
      // Os trajetos dos figurantes + um anel de pontos na calçada externa e no
      // pátio, para a praça grande não ter só quatro caminhos.
      const out = plazaDestinations();
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        for (const r of [PLAZA.apron - 2, PLAZA.radius - 8]) out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
      }
      return dedupe(out.filter((p) => isFree(id, p, 0.2)));
    }
    case 'noir_district':
      return noirDestinations();
    default:
      return interiorDestinations(id);
  }
}

/** Direção de um yaw como ponto "à frente" (para `Walker.face`). */
export function ahead(from: Point, yaw: number, d = 3): Point {
  return { x: from.x + Math.sin(yaw) * d, z: from.z + Math.cos(yaw) * d };
}

/** Onde o clima do mundo é desenhado (e sentido): só a praça. O Distrito Sombra chove sempre, por desenho; interiores têm teto. */
export function weatherApplies(id: SceneId): boolean {
  return id === 'central_plaza';
}

const coveredCache = new Map<SceneId, Point[]>();

/**
 * Pontos cobertos da cena: onde um figurante se abriga quando chove. Na
 * praça: debaixo das copas do anel interno de árvores, encostado aos
 * quiosques (que têm toldo) e nas entradas das portas (marquise). Só a
 * praça precisa disto — é a única cena onde chove de verdade.
 */
export function coveredPoints(id: SceneId): Point[] {
  const hit = coveredCache.get(id);
  if (hit) return hit;
  const out: Point[] = [];
  if (id === 'central_plaza') {
    for (const t of PLAZA.trees) {
      const r = Math.hypot(t.x, t.z);
      if (r < 1e-6 || r > PLAZA.radius - 3) continue;
      // Um passo para dentro do tronco: sob a copa, fora do colisor.
      const k = (r - 1.1) / r;
      out.push(nearestFree(id, { x: t.x * k, z: t.z * k }));
    }
    for (const k of PLAZA.kiosks) {
      const r = Math.hypot(k.x, k.z);
      for (const [d, side] of [[2.3, 0.9], [2.3, -0.9]] as Array<[number, number]>) {
        const kk = (r - d) / r;
        const tx = -k.z / r;
        const tz = k.x / r;
        out.push(nearestFree(id, { x: k.x * kk + tx * side, z: k.z * kk + tz * side }));
      }
    }
    for (const portal of PORTALS.central_plaza ?? []) {
      const r = Math.hypot(portal.x, portal.z);
      const kk = (r - 3.2) / r;
      out.push(nearestFree(id, { x: portal.x * kk, z: portal.z * kk }));
    }
  }
  const free = out.filter((p) => isFree(id, p, 0));
  coveredCache.set(id, free);
  return free;
}

/** Este ponto está coberto (a menos de 1,6 m de um abrigo)? */
export function isCovered(id: SceneId, p: Point): boolean {
  return coveredPoints(id).some((c) => Math.hypot(c.x - p.x, c.z - p.z) <= 1.6);
}
