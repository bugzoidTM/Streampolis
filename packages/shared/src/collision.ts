import { PLAZA } from './layout.js';
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

/** Blockers per scene. Empty means "only the area limit applies". */
export const SCENE_COLLIDERS: Record<SceneId, readonly Collider[]> = {
  central_plaza: plazaColliders(),
  residential_lobby: [],
  apartment: [],
  stream_store: [],
  agency_tower: [],
  pk_arena: [],
  live_room: [],
};

/**
 * Walkable limit per scene. The plaza is a disc; the rest keep the rectangle
 * their PLAY_AREA already describes, so `null` means "use PLAY_AREA".
 */
export const SCENE_AREA: Partial<Record<SceneId, Area>> = {
  central_plaza: { kind: 'circle', x: 0, z: 0, r: PLAZA.radius },
};
