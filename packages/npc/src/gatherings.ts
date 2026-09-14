import { placesOf } from './places.js';
import { nearestFree } from './scenes.js';
import { PLAZA, type SceneId } from './shared.js';
import type { Point } from './walker.js';

/**
 * Rodinhas: dois ou três personagens juntos num ponto social por alguns
 * minutos, depois cada um segue a sua vida.
 *
 * O registro é do PROCESSO (todos os personagens de uma sala vivem no mesmo),
 * por sala e não por cena: dois shards da mesma praça são duas praças. Uma
 * rodinha tem um centro num ponto social da cena (quiosque, frente de banco,
 * pátio do monumento, esquina do bar…), vagas em círculo à volta dele já
 * conferidas contra a planta, uma lotação (2 ou 3) e um prazo. Quem entra
 * anda até a vaga, fica virado para o centro e faz um gesto de vez em quando;
 * vencido o prazo — ou esvaziada — a rodinha some e ninguém volta a ela por um
 * tempo. Não há chat nem modelo: a conversa é a postura.
 */
export interface Gathering {
  id: number;
  sceneId: SceneId;
  roomId: string;
  center: Point;
  slots: Point[];
  /** Quem está, com o índice da vaga. */
  members: Map<string, number>;
  openedAt: number;
  until: number;
}

export const GATHER = {
  /** Vida de uma rodinha. */
  minMs: 120_000,
  maxMs: 300_000,
  /** Não se entra numa rodinha que está para acabar. */
  minLeftMs: 45_000,
  /** Raio do círculo de vagas. */
  ringM: 0.85,
  /** Duas rodinhas na mesma sala ficam a pelo menos isto uma da outra. */
  apartM: 7,
  maxPerRoom: 2,
  /** Quem saiu de uma não entra noutra antes disto. */
  cooldownMs: 8 * 60_000,
} as const;

const pointsCache = new Map<SceneId, Point[]>();

/** Onde as pessoas param para conversar, em cada cena. */
export function socialPoints(sceneId: SceneId): Point[] {
  const hit = pointsCache.get(sceneId);
  if (hit) return hit;
  const out: Point[] = [];
  if (sceneId === 'central_plaza') {
    for (const p of placesOf(sceneId)) if (/quiosque|monumento|telão/.test(p.name)) out.push(p.standing);
    // Frente dos bancos do anel interno (as vagas de sentar ficam encostadas;
    // a rodinha fica um passo à frente, de pé).
    for (const b of PLAZA.benches.slice(0, 16)) {
      const r = Math.hypot(b.x, b.z);
      const k = (r - 2.4) / r;
      out.push({ x: b.x * k, z: b.z * k });
    }
  } else if (sceneId === 'noir_district') {
    for (const p of placesOf(sceneId)) if (/bar|café|clube|doca|metrô|hotel|lavanderia/.test(p.name)) out.push(p.standing);
    out.push({ x: -24, z: -14 }, { x: 33, z: -14 });
  } else if (sceneId === 'noir_club') {
    out.push({ x: -6.5, z: 4.5 }, { x: 6.5, z: 4.5 }, { x: -8, z: -4 }, { x: 8, z: -4 }, { x: 0, z: 7 });
  } else if (sceneId === 'residential_lobby') {
    out.push({ x: 0, z: 5 }, { x: -5, z: -3 }, { x: 5, z: -3 });
  } else if (sceneId === 'stream_store') {
    out.push({ x: 0, z: 4.4 }, { x: -4.6, z: 1 }, { x: 4.6, z: -4 });
  } else if (sceneId === 'agency_tower') {
    out.push({ x: 0, z: 6 }, { x: 6, z: 3 }, { x: -4, z: 8 });
  }
  const free = out.map((p) => nearestFree(sceneId, p));
  pointsCache.set(sceneId, free);
  return free;
}

class Registry {
  private list: Gathering[] = [];
  private seq = 0;

  /** Limpa as vencidas e as vazias há mais de meio minuto. */
  sweep(now = Date.now()): void {
    this.list = this.list.filter((g) => now < g.until && (g.members.size > 0 || now - g.openedAt < 30_000));
  }

  inRoom(roomId: string): Gathering[] {
    this.sweep();
    return this.list.filter((g) => g.roomId === roomId);
  }

  /** Uma rodinha aberta, com vaga, com tempo, ao alcance. A mais perto. */
  joinable(roomId: string, from: Point, maxDist: number, now = Date.now()): Gathering | null {
    let best: { g: Gathering; d: number } | null = null;
    for (const g of this.inRoom(roomId)) {
      if (g.members.size >= g.slots.length) continue;
      if (g.until - now < GATHER.minLeftMs) continue;
      const d = Math.hypot(g.center.x - from.x, g.center.z - from.z);
      if (d > maxDist) continue;
      if (!best || d < best.d) best = { g, d };
    }
    return best?.g ?? null;
  }

  /** Abre uma rodinha nova num ponto social livre da cena, se a sala comportar. */
  open(sceneId: SceneId, roomId: string, near: Point, maxDist: number, rng: () => number, now = Date.now(), only: ((p: Point) => boolean) | null = null): Gathering | null {
    const mine = this.inRoom(roomId);
    if (mine.length >= GATHER.maxPerRoom) return null;
    const candidates = socialPoints(sceneId)
      .filter((p) => !only || only(p))
      .filter((p) => Math.hypot(p.x - near.x, p.z - near.z) <= maxDist)
      .filter((p) => mine.every((g) => Math.hypot(g.center.x - p.x, g.center.z - p.z) >= GATHER.apartM));
    if (!candidates.length) return null;
    const center = candidates[Math.floor(rng() * candidates.length)]!;
    const capacity = rng() < 0.55 ? 2 : 3;
    const phase = rng() * Math.PI * 2;
    const slots: Point[] = [];
    for (let i = 0; i < capacity; i++) {
      const a = phase + (i / capacity) * Math.PI * 2;
      slots.push(nearestFree(sceneId, { x: center.x + Math.cos(a) * GATHER.ringM, z: center.z + Math.sin(a) * GATHER.ringM }, 0.05));
    }
    const g: Gathering = {
      id: ++this.seq, sceneId, roomId, center, slots, members: new Map(),
      openedAt: now, until: now + GATHER.minMs + rng() * (GATHER.maxMs - GATHER.minMs),
    };
    this.list.push(g);
    return g;
  }

  /** Entra: devolve a vaga, ou nula se não coube. */
  join(g: Gathering, id: string): Point | null {
    if (g.members.has(id)) return g.slots[g.members.get(id)!]!;
    const taken = new Set(g.members.values());
    for (let i = 0; i < g.slots.length; i++) {
      if (taken.has(i)) continue;
      g.members.set(id, i);
      return g.slots[i]!;
    }
    return null;
  }

  leave(g: Gathering, id: string): void {
    g.members.delete(id);
  }

  alive(g: Gathering, now = Date.now()): boolean {
    return now < g.until && this.list.includes(g);
  }

  /** Só para testes e para o /health. */
  all(): Gathering[] {
    this.sweep();
    return [...this.list];
  }

  reset(): void {
    this.list = [];
  }
}

export const GATHERINGS = new Registry();
