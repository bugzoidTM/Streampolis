/**
 * The bridge from a SHOP ITEM to a piece of geometry, and the rules for where
 * it may stand.
 *
 * It lives in `shared` and not in the client for the same reason `layout.ts`
 * does: the server has to be able to refuse a placement. A client that decides
 * on its own where a sofa fits is a client that can put a sofa inside a wall,
 * or inside another player's sofa, and say it did.
 */

export type Mount = 'floor' | 'wall' | 'ceiling' | 'surface';

export interface Placeable {
  /** Builder key; the client's prop kit dispatches on it. */
  kind: string;
  /** Where it may be put. */
  mount: Mount;
  /** Half-extents of the blocker, in the prop's own frame. Omit to walk through. */
  hw?: number;
  hd?: number;
  /** Default height above the floor. */
  y?: number;
  /** Builder arguments, passed through to the prop kit. */
  w?: number;
  h?: number;
  d?: number;
  tint?: string;
  color?: number;
}

/**
 * Every placeable in the catalogue. An item without an entry here cannot be
 * placed — which is the correct failure: a shop item with no geometry behind
 * it is exactly the bug the accessories had.
 */
export const PLACEABLES: Record<string, Placeable> = {
  // --- Seating and tables -------------------------------------------------
  fur_sofa_01:    { kind: 'sofa',         mount: 'floor', w: 1.92, hw: 0.98, hd: 0.42, tint: '#4a5a78' },
  fur_sofa_02:    { kind: 'sofa',         mount: 'floor', w: 1.40, hw: 0.72, hd: 0.42, tint: '#7a5c4a' },
  fur_chair_01:   { kind: 'armchair',     mount: 'floor', hw: 0.42, hd: 0.40, tint: '#7a5c8a' },
  fur_stool_01:   { kind: 'stool',        mount: 'floor', h: 0.62, hw: 0.20, hd: 0.20 },
  fur_deskchair_01:{ kind: 'desk_chair',  mount: 'floor', hw: 0.30, hd: 0.30 },
  fur_table_01:   { kind: 'coffee_table', mount: 'floor', w: 1.10, d: 0.60, hw: 0.56, hd: 0.32 },
  fur_desk_01:    { kind: 'desk',         mount: 'floor', w: 1.40, d: 0.68, hw: 0.72, hd: 0.36 },
  fur_bed_01:     { kind: 'bed',          mount: 'floor', w: 1.40, d: 2.00, hw: 0.72, hd: 1.02 },
  fur_shelf_01:   { kind: 'shelf',        mount: 'floor', w: 1.20, h: 1.90, hw: 0.62, hd: 0.18 },

  // --- Soft furnishing ----------------------------------------------------
  // No blocker on purpose: you walk on a rug.
  fur_rug_01:     { kind: 'rug',          mount: 'floor', w: 1.80, d: 1.20, tint: '#8a6f62' },
  fur_rug_02:     { kind: 'rug',          mount: 'floor', w: 2.40, d: 1.60, tint: '#3f5a52' },

  // --- Green --------------------------------------------------------------
  fur_plant_01:   { kind: 'pot_plant',    mount: 'floor', hw: 0.22, hd: 0.22 },
  fur_planttall_01:{ kind: 'plant_tall',  mount: 'floor', h: 1.35, hw: 0.28, hd: 0.28 },

  // --- Light --------------------------------------------------------------
  fur_lamp_01:    { kind: 'floor_lamp',   mount: 'floor', h: 1.55, hw: 0.20, hd: 0.20 },
  fur_ceiling_01: { kind: 'ceiling_lamp', mount: 'ceiling' },
  fur_led_01:     { kind: 'led_strip',    mount: 'wall', w: 1.60, y: 1.85, color: 0x7c5cff },
  fur_neon_01:    { kind: 'wall_neon',    mount: 'wall', y: 1.70, color: 0xff3d9a },

  // --- Walls --------------------------------------------------------------
  fur_art_01:     { kind: 'wall_art',     mount: 'wall', w: 0.70, h: 0.90, y: 1.55, color: 0x8ea9c4 },
  fur_art_02:     { kind: 'wall_art',     mount: 'wall', w: 1.10, h: 0.70, y: 1.60, color: 0xc98a5a },

  // --- Screens and stream gear -------------------------------------------
  fur_tv_01:      { kind: 'tv_set',       mount: 'floor', w: 1.15, h: 0.66, hw: 0.62, hd: 0.20 },
  gear_pc_01:     { kind: 'pc_tower',     mount: 'floor', hw: 0.12, hd: 0.24 },
  gear_mic_01:    { kind: 'mic_boom',     mount: 'surface', y: 0.74 },
  gear_cam_01:    { kind: 'camera_rig',   mount: 'floor', hw: 0.22, hd: 0.22 },
  gear_ring_01:   { kind: 'ring_light',   mount: 'floor', hw: 0.24, hd: 0.24 },
  gear_backdrop_01:{ kind: 'led_wall',    mount: 'wall', w: 2.60, h: 1.60, y: 0.90, color: 0x2fd8ff },
  gear_monitor_01:{ kind: 'monitor',      mount: 'surface', w: 0.62, h: 0.36, y: 0.74 },

  // --- Small stuff --------------------------------------------------------
  fur_books_01:   { kind: 'trinkets',     mount: 'surface', y: 0.74 },
};

/** Items a build mode may offer. */
export function isPlaceable(itemId: string): boolean {
  return Object.hasOwn(PLACEABLES, itemId);
}

/**
 * A placement the owner asked for. `ry` is a quarter-turn index rather than a
 * float: build mode rotates in 90° steps, and storing radians invites a client
 * to send 0.37 and a room to look subtly wrong forever.
 */
export interface HomePlacement {
  itemId: string;
  x: number;
  z: number;
  /** 0..3, quarter turns. */
  turn: number;
}

/** Room bounds a placement must respect, in metres from the room centre. */
export interface RoomBounds { halfW: number; halfD: number }

/**
 * Is this placement legal? Shared so the client can grey out an illegal spot
 * and the server can refuse the same one, with the same arithmetic.
 */
export function placementFits(p: HomePlacement, bounds: RoomBounds): boolean {
  const def = PLACEABLES[p.itemId];
  if (!def) return false;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  if (!Number.isInteger(p.turn) || p.turn < 0 || p.turn > 3) return false;

  // Half-extents swap on an odd quarter-turn.
  const hw = def.hw ?? 0.25;
  const hd = def.hd ?? 0.25;
  const [ex, ez] = p.turn % 2 === 0 ? [hw, hd] : [hd, hw];
  const margin = 0.06;
  return Math.abs(p.x) + ex <= bounds.halfW - margin
    && Math.abs(p.z) + ez <= bounds.halfD - margin;
}

/** Do two placements overlap? Axis-aligned, because the grid is. */
export function placementsOverlap(a: HomePlacement, b: HomePlacement): boolean {
  const da = PLACEABLES[a.itemId];
  const db = PLACEABLES[b.itemId];
  if (!da || !db) return false;
  // Rugs and wall art are walk-through, and stacking a mug on a desk is the
  // point of a surface mount: only floor blockers fight for space.
  if (da.hw === undefined || db.hw === undefined) return false;
  if (da.mount !== 'floor' || db.mount !== 'floor') return false;

  const ext = (p: HomePlacement, d: Placeable): [number, number] =>
    (p.turn % 2 === 0 ? [d.hw ?? 0.25, d.hd ?? 0.25] : [d.hd ?? 0.25, d.hw ?? 0.25]);
  const [ax, az] = ext(a, da);
  const [bx, bz] = ext(b, db);
  return Math.abs(a.x - b.x) < ax + bx && Math.abs(a.z - b.z) < az + bz;
}
