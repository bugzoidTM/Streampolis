import { PLAZA, PLAYER_RADIUS, SCENE_COLLIDERS, penetrates, type SceneId } from './shared.js';
import type { Point } from './walker.js';

/**
 * Onde dá para sentar. O jogo não tem "encaixe" em assento: sentar é o gesto
 * `sit` no lugar onde a pessoa está, e o banco é um colisor — quem senta num
 * banco está em pé na borda dele e faz o gesto. Um ASSENTO, então, é uma vaga
 * na frente de um banco (o lado voltado para o centro da praça), fora do
 * colisor, com o corpo encostado nele. Três vagas por banco, como três
 * pessoas lado a lado. O sistema de móveis não muda: só se lê onde os bancos
 * estão.
 */

export interface Seat {
  /** Onde ficar em pé (e sentar). */
  at: Point;
  /** Para onde o corpo fica virado sentado: de costas para o banco. */
  yaw: number;
  bench: Point;
}

/** Vaga ocupada se há alguém a menos disto dela (dois raios e uma folga). */
export const SEAT_TAKEN_M = 0.7;
/** Sentar "junto" é a este alcance da pessoa; mais longe é sentar em outro lugar. */
export const SEAT_NEAR_M = 6;

const SLOTS = [-0.55, 0, 0.55];

export function sceneSeats(sceneId: SceneId): Seat[] {
  if (sceneId !== 'central_plaza') return [];
  const colliders = SCENE_COLLIDERS[sceneId] ?? [];
  const out: Seat[] = [];
  for (const b of PLAZA.benches) {
    // Colisor do banco: hw 0,9 no eixo local x, hd 0,35 no z, girado de `ry`
    // (a mesma convenção de `penetrates`). A frente é o lado do centro.
    const cos = Math.cos(b.ry);
    const sin = Math.sin(b.ry);
    const local = (lx: number, lz: number): Point => ({ x: b.x + lx * cos - lz * sin, z: b.z + lx * sin + lz * cos });
    const depth = 0.35 + PLAYER_RADIUS + 0.06;
    const side = Math.hypot(local(0, depth).x, local(0, depth).z) < Math.hypot(local(0, -depth).x, local(0, -depth).z) ? 1 : -1;
    for (const lx of SLOTS) {
      const at = local(lx, side * depth);
      if (penetrates(at, colliders)) continue;
      const bench = { x: b.x, z: b.z };
      out.push({ at, yaw: Math.atan2(at.x - bench.x, at.z - bench.z), bench });
    }
  }
  return out;
}

/**
 * A vaga livre mais perto da pessoa, a até `SEAT_NEAR_M` dela. Livre = ninguém
 * (nem a própria pessoa, nem eu) em cima dela.
 */
export function freeSeatNear(seats: readonly Seat[], person: Point, occupied: readonly Point[]): Seat | null {
  let best: { seat: Seat; d: number } | null = null;
  for (const seat of seats) {
    const d = Math.hypot(seat.at.x - person.x, seat.at.z - person.z);
    if (d > SEAT_NEAR_M) continue;
    if (occupied.some((o) => Math.hypot(o.x - seat.at.x, o.z - seat.at.z) < SEAT_TAKEN_M)) continue;
    if (!best || d < best.d) best = { seat, d };
  }
  return best?.seat ?? null;
}
