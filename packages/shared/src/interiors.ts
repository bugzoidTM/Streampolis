import type { SceneId } from './types.js';
import type { Placement } from './layout.js';

/**
 * Interior layouts as DATA, for the same reason `layout.ts` exists: the server
 * has to know where the sofa is. The browser reads this file to build the
 * geometry and `collision.ts` reads it to build the blocker table, so a fixture
 * moved here moves on both sides at once.
 *
 * Conventions, everywhere below:
 *   - the room is centred on the origin; `width` runs along X, `depth` along Z;
 *   - north is -Z, south is +Z, east is +X, west is -X;
 *   - `ry` is the yaw applied to a prop authored facing +Z;
 *   - `hw`/`hd` are the blocker half-extents in the prop's own frame (before
 *     `ry`), matching the collider convention in `collision.ts`; `r` makes it a
 *     cylinder instead. A fixture with neither is walk-through (rugs, ceiling
 *     lamps, wall art), which is a decision, not an omission.
 */

export type WallSide = 'north' | 'south' | 'east' | 'west';

/**
 * A hole in a wall. `x` is authored in WORLD axis units (X for north/south
 * walls, Z for east/west), because an opening measured in the wall's own
 * flipped local frame is impossible to keep straight while editing.
 */
export interface WallOpening {
  side: WallSide;
  x: number;
  /** Height of the sill above the floor; 0 for a door. */
  y: number;
  w: number;
  h: number;
  /** Fills the hole with a window frame; doors get a door frame instead. */
  glazed?: boolean;
}

export interface RoomShell {
  width: number;
  depth: number;
  height: number;
  /** Wall thickness. Walls grow OUTWARD, so the interior keeps its size. */
  wall: number;
  openings: WallOpening[];
  /** No ceiling geometry when false — arenas read better open to the truss. */
  ceiling: boolean;
}

export interface Fixture extends Omit<Placement, 'ry'> {
  /** Builder key; the client's prop kit dispatches on it. */
  kind: string;
  /** Yaw of a prop authored facing +Z. Defaults to 0. */
  ry?: number;
  /** Height above the floor. Defaults to 0. */
  y?: number;
  /** Blocker half-extents in the prop's own frame; omit to walk through it. */
  hw?: number;
  hd?: number;
  r?: number;
  /** Builder arguments. Meaning depends on `kind`. */
  w?: number;
  h?: number;
  d?: number;
  tint?: string;
  color?: number;
  /** Aim point for spotlights, in world coordinates. */
  aim?: [number, number, number];
}

export interface SpawnMarker {
  x: number;
  z: number;
  /** Facing. Omitted means "look at the middle of the room". */
  yaw?: number;
}

export interface SceneLayout {
  shell: RoomShell;
  fixtures: Fixture[];
  spawns: SpawnMarker[];
}

const PI = Math.PI;

// ---------------------------------------------------------------------------
// Apartment — the studio every player starts with (PRD §14).
// ---------------------------------------------------------------------------
export const APARTMENT: SceneLayout = {
  shell: {
    width: 7.2, depth: 8.4, height: 2.85, wall: 0.18, ceiling: true,
    openings: [
      // The window is off-centre and large: a studio lit from one corner reads
      // as a lived-in flat, a symmetric one reads as a showroom.
      { side: 'north', x: 0.7, y: 0.95, w: 3.2, h: 1.45, glazed: true },
      { side: 'west', x: -1.2, y: 1.0, w: 1.4, h: 1.3, glazed: true },
      { side: 'south', x: -2.2, y: 0, w: 0.95, h: 2.1 },
    ],
  },
  fixtures: [
    { kind: 'bed', x: -2.45, z: -2.9, ry: PI / 2, hw: 0.7, hd: 1.05 },
    { kind: 'rug', x: -1.75, z: 1.5, ry: PI / 2, w: 2.6, d: 1.9, tint: '#7c5f56' },
    { kind: 'sofa', x: -3.05, z: 1.5, ry: PI / 2, hw: 0.96, hd: 0.44, w: 1.92, tint: '#46566f' },
    { kind: 'coffee_table', x: -1.5, z: 1.5, ry: PI / 2, hw: 0.55, hd: 0.3, w: 1.1, d: 0.6 },
    { kind: 'tv', x: 3.5, z: 1.5, ry: -PI / 2, y: 1.0, w: 1.7, h: 0.96 },
    { kind: 'shelf', x: 3.38, z: -0.9, ry: -PI / 2, hw: 0.6, hd: 0.16, w: 1.2, h: 1.9 },

    // Streaming corner: desk under the window, gear on top, neon behind it.
    { kind: 'desk', x: 1.95, z: -3.72, ry: 0, hw: 0.7, hd: 0.34, w: 1.4, d: 0.68 },
    { kind: 'monitor', x: 1.95, z: -3.86, ry: 0, y: 0.763, w: 0.62, h: 0.36 },
    { kind: 'desk_gear', x: 1.95, z: -3.7, ry: 0, y: 0.763 },
    { kind: 'desk_chair', x: 1.95, z: -2.95, ry: PI, r: 0.3 },
    { kind: 'ring_light', x: 0.85, z: -3.3, ry: 0.5, r: 0.2 },
    { kind: 'wall_neon', x: 3.48, z: -2.5, ry: -PI / 2, y: 1.8, color: 0xff3d9a },

    { kind: 'kitchenette', x: 1.85, z: 3.8, ry: PI, hw: 1.2, hd: 0.32, w: 2.4 },
    { kind: 'stool', x: 0.4, z: 2.95, r: 0.2 },
    { kind: 'stool', x: 1.15, z: 2.95, r: 0.2 },

    { kind: 'pot_plant', x: 3.05, z: 3.3, r: 0.28, s: 1.15 },
    { kind: 'pot_plant', x: -3.05, z: -0.3, r: 0.24, s: 0.85 },
    { kind: 'floor_lamp', x: -3.15, z: 3.2, r: 0.2, h: 1.55 },
    { kind: 'ceiling_lamp', x: -1.5, z: 1.5, y: 2.85 },
    { kind: 'ceiling_lamp', x: 1.6, z: 3.0, y: 2.85 },
    { kind: 'wall_art', x: -3.49, z: 0.4, ry: PI / 2, y: 1.6, w: 0.7, h: 0.9, color: 0x8ea9c4 },
    { kind: 'wall_art', x: -3.49, z: -0.9, ry: PI / 2, y: 1.55, w: 0.55, h: 0.7, color: 0xc48ea0 },
  ],
  spawns: [
    { x: -1.9, z: 2.9 }, { x: -0.7, z: 3.0 }, { x: 0.5, z: 1.6 },
    { x: -1.2, z: 0.2 }, { x: 1.4, z: -1.4 }, { x: -0.4, z: -2.2 },
  ],
};

// ---------------------------------------------------------------------------
// Live Room — one host, a wall of LED, and room for a guest (PRD §10).
// Deliberately small: a live must not pay for a city (SPECs §10).
// ---------------------------------------------------------------------------
export const LIVE_ROOM: SceneLayout = {
  shell: {
    width: 9.4, depth: 10.2, height: 4.4, wall: 0.2, ceiling: true,
    openings: [{ side: 'south', x: 3.2, y: 0, w: 1.1, h: 2.2 }],
  },
  fixtures: [
    // The set: a backdrop of LED with the host's mark on the floor in front.
    { kind: 'led_wall', x: 0, z: -4.85, ry: 0, w: 6.6, h: 3.3, y: 0.62, hw: 3.4, hd: 0.3 },
    { kind: 'stage_mark', x: 0, z: -2.6, ry: 0, w: 5.0, d: 2.6, color: 0xff3d7f },
    { kind: 'neon_sign', x: -3.9, z: -4.8, ry: 0, y: 2.5, color: 0x2fd8ff },
    { kind: 'neon_sign', x: 3.9, z: -4.8, ry: 0, y: 2.5, color: 0xff3d9a },
    { kind: 'truss', x: 0, z: -1.4, y: 3.85, w: 8.6 },
    { kind: 'spot', x: -2.7, z: -1.4, y: 3.7, color: 0xff5aa8, aim: [-1.1, 1.2, -3.0] },
    { kind: 'spot', x: 0, z: -1.4, y: 3.7, color: 0xfff0dc, aim: [0, 1.3, -2.6] },
    { kind: 'spot', x: 2.7, z: -1.4, y: 3.7, color: 0x4a9dff, aim: [1.1, 1.2, -3.0] },

    // House wash over the room itself. The three lamps above only light the
    // set; anyone standing back in the room would be a silhouette.
    { kind: 'spot', x: -2.2, z: 2.4, y: 3.9, color: 0xffe9d4, aim: [-1.4, 1.2, 2.2] },
    { kind: 'spot', x: 2.2, z: 2.4, y: 3.9, color: 0xffe9d4, aim: [1.4, 1.2, 2.2] },

    { kind: 'ring_light', x: -1.7, z: -1.5, ry: 0.42, r: 0.2 },
    // Fora do eixo do palco: no meio, ele fica exatamente onde o braço de
    // câmera do jogador quer passar e encurta o enquadramento inteiro.
    { kind: 'camera_rig', x: 2.1, z: 1.5, ry: PI - 0.5, r: 0.34 },
    { kind: 'speaker_stack', x: -4.2, z: -4.2, ry: 0.5, hw: 0.34, hd: 0.34 },
    { kind: 'speaker_stack', x: 4.2, z: -4.2, ry: -0.5, hw: 0.34, hd: 0.34 },

    // Guest corner, so a co-host has somewhere to be that is not the middle.
    { kind: 'sofa', x: 3.9, z: -0.6, ry: -PI / 2, hw: 0.86, hd: 0.44, w: 1.72, tint: '#5a3f6e' },
    { kind: 'coffee_table', x: 2.75, z: -0.6, ry: -PI / 2, hw: 0.5, hd: 0.28, w: 1.0, d: 0.55 },
    { kind: 'rug', x: 3.2, z: -0.6, ry: -PI / 2, w: 2.6, d: 2.0, tint: '#3b2f45' },
    { kind: 'stool', x: -4.0, z: -1.4, r: 0.2 },
    { kind: 'stool', x: -4.0, z: -0.2, r: 0.2 },
    { kind: 'pot_plant', x: -4.3, z: -4.3, r: 0.3, s: 1.25 },
    { kind: 'pot_plant', x: 4.3, z: 3.9, r: 0.3, s: 1.1 },
    { kind: 'wall_neon', x: -4.55, z: 1.2, ry: PI / 2, y: 2.1, color: 0xffcc33 },
  ],
  spawns: [
    // Numa Live Room só o palco tem corpo (SPECs §10): o espectador não ganha
    // avatar. Então a ordem aqui é a ordem do palco — host primeiro, co-host
    // depois —, e não uma fila de convidados.
    { x: 0, z: -2.6, yaw: 0 },
    { x: 1.7, z: -2.3, yaw: 0.16 },
    { x: -1.7, z: -2.3, yaw: -0.16 },
    { x: 0.6, z: -1.2, yaw: 0 }, { x: -0.6, z: -1.2, yaw: 0 },
    { x: 0, z: 0.4, yaw: 0 },
  ],
};

// ---------------------------------------------------------------------------
// PK Arena — two stages facing each other across a lit floor (PRD §6, §18).
// ---------------------------------------------------------------------------
export const PK_ARENA: SceneLayout = {
  shell: {
    width: 34, depth: 32, height: 11, wall: 0.4, ceiling: false,
    openings: [
      { side: 'east', x: 0, y: 0, w: 3.2, h: 3.2 },
      { side: 'west', x: 0, y: 0, w: 3.2, h: 3.2 },
    ],
  },
  fixtures: [
    // The two ends. Magenta is side A, blue is side B, everywhere in the room.
    { kind: 'led_wall', x: 0, z: -15.2, ry: 0, w: 12, h: 6.2, y: 1.4, hw: 6.2, hd: 0.5, color: 0xff3d7f },
    { kind: 'led_wall', x: 0, z: 15.2, ry: PI, w: 12, h: 6.2, y: 1.4, hw: 6.2, hd: 0.5, color: 0x2f7bff },
    { kind: 'stage_mark', x: 0, z: -11.0, ry: 0, w: 9.0, d: 5.0, color: 0xff3d7f },
    { kind: 'stage_mark', x: 0, z: 11.0, ry: PI, w: 9.0, d: 5.0, color: 0x2f7bff },
    { kind: 'centre_ring', x: 0, z: 0, ry: 0, w: 7.2, color: 0xffcc33 },

    // Scoreboards on the side walls, readable from either stage.
    { kind: 'led_wall', x: -16.6, z: 0, ry: PI / 2, w: 9, h: 4.4, y: 3.6, hw: 4.6, hd: 0.5, color: 0xffcc33 },
    { kind: 'led_wall', x: 16.6, z: 0, ry: -PI / 2, w: 9, h: 4.4, y: 3.6, hw: 4.6, hd: 0.5, color: 0xffcc33 },

    { kind: 'truss', x: 0, z: -7.5, y: 8.6, w: 26 },
    { kind: 'truss', x: 0, z: 0, y: 9.2, w: 26 },
    { kind: 'truss', x: 0, z: 7.5, y: 8.6, w: 26 },
    { kind: 'spot', x: -6.5, z: -7.5, y: 8.4, color: 0xff5aa8, aim: [-1.5, 1.4, -10.5] },
    { kind: 'spot', x: 6.5, z: -7.5, y: 8.4, color: 0xff5aa8, aim: [1.5, 1.4, -10.5] },
    { kind: 'spot', x: -6.5, z: 7.5, y: 8.4, color: 0x4a9dff, aim: [-1.5, 1.4, 10.5] },
    { kind: 'spot', x: 6.5, z: 7.5, y: 8.4, color: 0x4a9dff, aim: [1.5, 1.4, 10.5] },
    // House light: the crowd floor needs its own wash, or everyone standing
    // between the two stages is a silhouette against their own team's colour.
    { kind: 'spot', x: 0, z: 0, y: 9.0, color: 0xfff2d8, aim: [0, 1.2, 0] },
    { kind: 'spot', x: -7.5, z: 6.5, y: 8.6, color: 0xe8ecff, aim: [-6.5, 1.2, 6.0] },
    { kind: 'spot', x: 7.5, z: 6.5, y: 8.6, color: 0xe8ecff, aim: [6.5, 1.2, 6.0] },
    { kind: 'spot', x: -7.5, z: -6.5, y: 8.6, color: 0xe8ecff, aim: [-6.5, 1.2, -6.0] },
    { kind: 'spot', x: 7.5, z: -6.5, y: 8.6, color: 0xe8ecff, aim: [6.5, 1.2, -6.0] },

    // Accent bands high on the side walls: without them the upper half of the
    // frame is an unlit void and the room loses its ceiling.
    { kind: 'neon_sign', x: -16.9, z: -8, ry: PI / 2, y: 7.2, w: 6, h: 0.5, color: 0xff3d7f },
    { kind: 'neon_sign', x: -16.9, z: 8, ry: PI / 2, y: 7.2, w: 6, h: 0.5, color: 0x2f7bff },
    { kind: 'neon_sign', x: 16.9, z: -8, ry: -PI / 2, y: 7.2, w: 6, h: 0.5, color: 0xff3d7f },
    { kind: 'neon_sign', x: 16.9, z: 8, ry: -PI / 2, y: 7.2, w: 6, h: 0.5, color: 0x2f7bff },

    { kind: 'speaker_stack', x: -7.6, z: -14.6, ry: 0.35, hw: 0.5, hd: 0.5, h: 3.2 },
    { kind: 'speaker_stack', x: 7.6, z: -14.6, ry: -0.35, hw: 0.5, hd: 0.5, h: 3.2 },
    { kind: 'speaker_stack', x: -7.6, z: 14.6, ry: PI - 0.35, hw: 0.5, hd: 0.5, h: 3.2 },
    { kind: 'speaker_stack', x: 7.6, z: 14.6, ry: PI + 0.35, hw: 0.5, hd: 0.5, h: 3.2 },

    { kind: 'tower', x: -15.4, z: -14.4, ry: 0, hw: 0.7, hd: 0.7, h: 9.4 },
    { kind: 'tower', x: 15.4, z: -14.4, ry: 0, hw: 0.7, hd: 0.7, h: 9.4 },
    { kind: 'tower', x: -15.4, z: 14.4, ry: 0, hw: 0.7, hd: 0.7, h: 9.4 },
    { kind: 'tower', x: 15.4, z: 14.4, ry: 0, hw: 0.7, hd: 0.7, h: 9.4 },

    ...barrierRun(-13.4, -8.5, 8.5, 5, 0),
    ...barrierRun(13.4, -8.5, 8.5, 5, PI),
  ],
  spawns: [
    // Os dois palcos primeiro: num PK quem tem corpo são os dois hosts, e o
    // lado em que cada um está é o lado da cor dele.
    { x: 0, z: -10.5, yaw: 0 }, { x: 0, z: 10.5, yaw: PI },
    { x: -7.0, z: 7.5 }, { x: 7.0, z: 7.5 },
    { x: -4.5, z: -4.0 }, { x: 4.5, z: -4.0 },
    { x: -4.5, z: 4.0 }, { x: 4.5, z: 4.0 },
  ],
};

/** A straight line of crowd barriers along X, at a fixed X, spread over Z. */
function barrierRun(x: number, z0: number, z1: number, count: number, ry: number): Fixture[] {
  const out: Fixture[] = [];
  for (let i = 0; i < count; i++) {
    const z = z0 + ((z1 - z0) * i) / Math.max(1, count - 1);
    out.push({ kind: 'barrier', x, z, ry: ry + PI / 2, hw: 1.1, hd: 0.18, w: 2.2 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Residential lobby, store and agency: public interiors, same kit.
// ---------------------------------------------------------------------------
export const RESIDENTIAL_LOBBY: SceneLayout = {
  shell: {
    width: 20, depth: 20, height: 4.8, wall: 0.3, ceiling: true,
    openings: [
      { side: 'south', x: 0, y: 0, w: 3.4, h: 2.6 },
      { side: 'east', x: -2.5, y: 1.1, w: 4.5, h: 2.4, glazed: true },
      { side: 'east', x: 3.5, y: 1.1, w: 4.5, h: 2.4, glazed: true },
      { side: 'west', x: -2.5, y: 1.1, w: 4.5, h: 2.4, glazed: true },
      { side: 'west', x: 3.5, y: 1.1, w: 4.5, h: 2.4, glazed: true },
    ],
  },
  fixtures: [
    { kind: 'counter', x: -4.2, z: -8.2, ry: 0, hw: 1.8, hd: 0.45, w: 3.6 },
    { kind: 'shelf', x: -6.6, z: -9.5, ry: 0, hw: 0.6, hd: 0.16, w: 1.2, h: 2.1 },
    { kind: 'elevator', x: 4.0, z: -9.7, ry: 0, hw: 1.3, hd: 0.22, w: 2.6 },
    { kind: 'elevator', x: 7.6, z: -9.7, ry: 0, hw: 1.3, hd: 0.22, w: 2.6 },
    { kind: 'led_wall', x: 0.0, z: -9.7, ry: 0, w: 3.2, h: 1.8, y: 1.3, hw: 1.7, hd: 0.25, color: 0x39d98a },

    { kind: 'rug', x: 0, z: 1.5, ry: 0, w: 7.5, d: 5.5, tint: '#4d4a52' },
    { kind: 'sofa', x: -2.6, z: 1.5, ry: PI / 2, hw: 0.96, hd: 0.44, w: 1.92, tint: '#3f4c63' },
    { kind: 'sofa', x: 2.6, z: 1.5, ry: -PI / 2, hw: 0.96, hd: 0.44, w: 1.92, tint: '#3f4c63' },
    { kind: 'coffee_table', x: 0, z: 1.5, ry: 0, hw: 0.6, hd: 0.35, w: 1.2, d: 0.7 },
    { kind: 'armchair', x: 0, z: -1.2, ry: PI, hw: 0.43, hd: 0.44, tint: '#6b4f7c' },

    { kind: 'pot_plant', x: -8.6, z: -8.6, r: 0.3, s: 1.4 },
    { kind: 'pot_plant', x: 8.6, z: -8.6, r: 0.3, s: 1.4 },
    { kind: 'pot_plant', x: -8.6, z: 7.4, r: 0.3, s: 1.25 },
    { kind: 'pot_plant', x: 8.6, z: 7.4, r: 0.3, s: 1.25 },
    { kind: 'floor_lamp', x: -4.6, z: 3.6, r: 0.2, h: 1.7 },
    { kind: 'floor_lamp', x: 4.6, z: 3.6, r: 0.2, h: 1.7 },
    { kind: 'ceiling_lamp', x: -4, z: -4, y: 4.8 },
    { kind: 'ceiling_lamp', x: 4, z: -4, y: 4.8 },
    { kind: 'ceiling_lamp', x: -4, z: 4, y: 4.8 },
    { kind: 'ceiling_lamp', x: 4, z: 4, y: 4.8 },
    { kind: 'wall_art', x: -9.8, z: -3.0, ry: PI / 2, y: 2.0, w: 1.2, h: 1.6, color: 0x7f93b8 },
    { kind: 'wall_art', x: 9.8, z: -3.0, ry: -PI / 2, y: 2.0, w: 1.2, h: 1.6, color: 0xb88f7f },
  ],
  spawns: [
    { x: -1.6, z: 8.0 }, { x: 1.6, z: 8.0 }, { x: 0, z: 5.5 },
    { x: -3.4, z: 5.0 }, { x: 3.4, z: 5.0 }, { x: 0, z: -4.0 },
  ],
};

export const STREAM_STORE: SceneLayout = {
  shell: {
    width: 18, depth: 18, height: 4.4, wall: 0.3, ceiling: true,
    openings: [
      { side: 'south', x: 0, y: 0, w: 3.6, h: 2.7 },
      { side: 'south', x: -5.4, y: 1.0, w: 3.4, h: 2.2, glazed: true },
      { side: 'south', x: 5.4, y: 1.0, w: 3.4, h: 2.2, glazed: true },
    ],
  },
  fixtures: [
    { kind: 'counter', x: 5.6, z: -7.0, ry: 0, hw: 1.6, hd: 0.45, w: 3.2 },
    { kind: 'led_wall', x: 0, z: -8.7, ry: 0, w: 6.4, h: 3.0, y: 1.1, hw: 3.3, hd: 0.3, color: 0xff3d7f },
    { kind: 'stage_mark', x: 0, z: -6.4, ry: 0, w: 5.0, d: 2.4, color: 0xff3d7f },

    { kind: 'shelf', x: -7.4, z: -4.5, ry: PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.2 },
    { kind: 'shelf', x: -7.4, z: -2.4, ry: PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.2 },
    { kind: 'shelf', x: -7.4, z: -0.3, ry: PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.2 },
    { kind: 'shelf', x: 7.4, z: -0.3, ry: -PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.2 },
    { kind: 'shelf', x: 7.4, z: 1.8, ry: -PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.2 },

    { kind: 'display', x: -3.2, z: -1.6, ry: 0, r: 0.62, color: 0x2fd8ff },
    { kind: 'display', x: 0, z: -1.6, ry: 0, r: 0.62, color: 0xff3d9a },
    { kind: 'display', x: 3.2, z: -1.6, ry: 0, r: 0.62, color: 0xffcc33 },
    { kind: 'display', x: -3.2, z: 2.2, ry: 0, r: 0.62, color: 0x39d98a },
    { kind: 'display', x: 0, z: 2.2, ry: 0, r: 0.62, color: 0xb06bff },
    { kind: 'display', x: 3.2, z: 2.2, ry: 0, r: 0.62, color: 0xff7a45 },

    { kind: 'rug', x: 0, z: 5.4, ry: 0, w: 6.0, d: 3.4, tint: '#4a4552' },
    { kind: 'stool', x: -1.2, z: 5.4, r: 0.2 },
    { kind: 'stool', x: 0, z: 5.6, r: 0.2 },
    { kind: 'stool', x: 1.2, z: 5.4, r: 0.2 },
    { kind: 'pot_plant', x: -7.6, z: 6.6, r: 0.3, s: 1.2 },
    { kind: 'pot_plant', x: 7.6, z: 6.6, r: 0.3, s: 1.2 },
    { kind: 'truss', x: 0, z: -3.0, y: 3.9, w: 14 },
    { kind: 'spot', x: -3.2, z: -3.0, y: 3.75, color: 0xffe8cc, aim: [-3.2, 1.0, -1.6] },
    { kind: 'spot', x: 0, z: -3.0, y: 3.75, color: 0xffe8cc, aim: [0, 1.0, -1.6] },
    { kind: 'spot', x: 3.2, z: -3.0, y: 3.75, color: 0xffe8cc, aim: [3.2, 1.0, -1.6] },
    { kind: 'ceiling_lamp', x: -4.5, z: 4.5, y: 4.4 },
    { kind: 'ceiling_lamp', x: 4.5, z: 4.5, y: 4.4 },
  ],
  spawns: [
    { x: -1.4, z: 7.4 }, { x: 1.4, z: 7.4 }, { x: 0, z: 4.6 },
    { x: -4.0, z: 4.0 }, { x: 4.0, z: 4.0 }, { x: 0, z: 0.4 },
  ],
};

export const AGENCY_TOWER: SceneLayout = {
  shell: {
    width: 24, depth: 22, height: 3.8, wall: 0.3, ceiling: true,
    openings: [
      { side: 'south', x: 0, y: 0, w: 3.2, h: 2.4 },
      { side: 'north', x: -6, y: 0.9, w: 6.5, h: 2.2, glazed: true },
      { side: 'north', x: 1.5, y: 0.9, w: 6.5, h: 2.2, glazed: true },
      { side: 'north', x: 9, y: 0.9, w: 5.0, h: 2.2, glazed: true },
      { side: 'east', x: 0, y: 0.9, w: 8.0, h: 2.2, glazed: true },
    ],
  },
  fixtures: [
    { kind: 'counter', x: -8.0, z: 8.2, ry: PI, hw: 1.8, hd: 0.45, w: 3.6 },
    { kind: 'led_wall', x: -10.6, z: 4.5, ry: PI / 2, w: 5.4, h: 2.6, y: 1.0, hw: 2.8, hd: 0.3, color: 0xb06bff },

    // Two rows of workstations. Desks back to back, which is how a floor of
    // people who talk to each other all day is actually laid out.
    ...deskRow(-6.4, -3.5, 4, 2.6, 0),
    ...deskRow(-6.4, -1.6, 4, 2.6, PI),
    ...deskRow(-6.4, 3.0, 4, 2.6, 0),
    ...deskRow(-6.4, 4.9, 4, 2.6, PI),

    { kind: 'table', x: 7.4, z: -4.5, ry: 0, hw: 1.6, hd: 0.9, w: 3.2, d: 1.8 },
    { kind: 'desk_chair', x: 5.4, z: -4.5, ry: -PI / 2, r: 0.3 },
    { kind: 'desk_chair', x: 9.4, z: -4.5, ry: PI / 2, r: 0.3 },
    { kind: 'desk_chair', x: 6.6, z: -6.0, ry: 0, r: 0.3 },
    { kind: 'desk_chair', x: 8.2, z: -6.0, ry: 0, r: 0.3 },
    { kind: 'desk_chair', x: 6.6, z: -3.0, ry: PI, r: 0.3 },
    { kind: 'desk_chair', x: 8.2, z: -3.0, ry: PI, r: 0.3 },

    { kind: 'sofa', x: 8.4, z: 6.4, ry: PI, hw: 0.96, hd: 0.44, w: 1.92, tint: '#43506b' },
    { kind: 'coffee_table', x: 8.4, z: 4.9, ry: 0, hw: 0.55, hd: 0.3, w: 1.1, d: 0.6 },
    { kind: 'rug', x: 8.4, z: 5.6, ry: 0, w: 3.6, d: 3.0, tint: '#514a58' },
    { kind: 'shelf', x: -11.6, z: -2.0, ry: PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.1 },
    { kind: 'shelf', x: -11.6, z: 0.2, ry: PI / 2, hw: 0.9, hd: 0.16, w: 1.8, h: 2.1 },
    { kind: 'pot_plant', x: -11.0, z: 9.0, r: 0.3, s: 1.3 },
    { kind: 'pot_plant', x: 11.0, z: -9.0, r: 0.3, s: 1.3 },
    { kind: 'pot_plant', x: 2.6, z: 9.0, r: 0.3, s: 1.1 },
    { kind: 'floor_lamp', x: 10.6, z: 8.4, r: 0.2, h: 1.7 },
    { kind: 'ceiling_lamp', x: -6, z: -2.5, y: 3.8 },
    { kind: 'ceiling_lamp', x: 0, z: -2.5, y: 3.8 },
    { kind: 'ceiling_lamp', x: -6, z: 4.0, y: 3.8 },
    { kind: 'ceiling_lamp', x: 0, z: 4.0, y: 3.8 },
    { kind: 'ceiling_lamp', x: 7.4, z: -4.5, y: 3.8 },
    { kind: 'wall_art', x: -11.8, z: 5.6, ry: PI / 2, y: 1.9, w: 1.1, h: 1.5, color: 0x8f7fb8 },
  ],
  spawns: [
    { x: -1.4, z: 9.0 }, { x: 1.4, z: 9.0 }, { x: 0, z: 6.4 },
    { x: -4.0, z: 6.6 }, { x: 4.0, z: 6.6 }, { x: 3.0, z: 0.5 },
  ],
};

/** A row of desks with a monitor and a chair each, marching along +X. */
function deskRow(x0: number, z: number, count: number, pitch: number, ry: number): Fixture[] {
  const out: Fixture[] = [];
  const back = ry === 0 ? -1 : 1;
  for (let i = 0; i < count; i++) {
    const x = x0 + i * pitch;
    out.push({ kind: 'desk', x, z, ry, hw: 0.75, hd: 0.36, w: 1.5, d: 0.7 });
    out.push({ kind: 'monitor', x, z: z + back * 0.14, ry, y: 0.763, w: 0.56, h: 0.33 });
    out.push({ kind: 'desk_chair', x, z: z - back * 0.78, ry: ry + Math.PI, r: 0.3 });
  }
  return out;
}

/** Every scene that is a room. The plaza is authored in `layout.ts` instead. */
export const INTERIORS: Partial<Record<SceneId, SceneLayout>> = {
  apartment: APARTMENT,
  live_room: LIVE_ROOM,
  pk_arena: PK_ARENA,
  residential_lobby: RESIDENTIAL_LOBBY,
  stream_store: STREAM_STORE,
  agency_tower: AGENCY_TOWER,
};
