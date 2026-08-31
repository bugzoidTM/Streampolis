import { AGENCY_TOWER, RESIDENTIAL_LOBBY, STREAM_STORE } from '@streampolis/shared';
import { LOOK_INTERIOR } from '../Renderer.js';
import { ROOM_DAY } from '../Environment.js';
import { InteriorScene, type InteriorStyle } from './InteriorScene.js';

/**
 * The three public interiors: the tower lobby you come home to, the shop, and
 * the agency floor (PRD §6). They share the interior engine and differ in the
 * only three things that actually distinguish a room — its surfaces, its light
 * and its grade.
 */

const LOBBY_STYLE: InteriorStyle = {
  look: { ...LOOK_INTERIOR, exposure: 0.9, vignette: 0.3, bloomStrength: 0.26 },
  lighting: {
    ...ROOM_DAY,
    keyDirection: [0.62, -0.62, -0.48],
    keyIntensity: 2.4,
    keyRadius: 13,
    ambientIntensity: 0.46,
    envTop: 0xa8bdd6, envSide: 0x7c7870, envWindow: 0xd8e8ff,
    fogNear: 34, fogFar: 140,
  },
  screen: [0x39d98a, 0x2f7bff],
  practicals: 0.9,
  shell: (lib) => ({
    floor: lib.paving('#b3aca1', '#6a655d'),
    wall: lib.plaster('#ddd6c9'),
    ceiling: lib.plaster('#efece5'),
    trim: lib.metal('#8d8578', 0.45, 0.6),
    floorTile: 1.5,
    wallTile: 2.0,
    view: { top: 0x7fa8d8, bottom: 0xd0dcea, sun: 0xf1e2c8 },
  }),
};

const STORE_STYLE: InteriorStyle = {
  look: { ...LOOK_INTERIOR, exposure: 0.92, saturation: 1.12, bloomStrength: 0.4, vignette: 0.32 },
  lighting: {
    ...ROOM_DAY,
    keyDirection: [-0.1, -0.82, -0.56],
    keyColor: 0xffeede,
    keyIntensity: 1.9,
    keyRadius: 11,
    ambientIntensity: 0.5,
    ceilingColor: 0xf0f2f8,
    envTop: 0xc8d2e0, envSide: 0x8d8a92, envWindow: 0xe6f0ff,
    fogNear: 30, fogFar: 120,
  },
  screen: [0xff3d7f, 0x2fd8ff],
  beams: true,
  practicals: 1.0,
  shell: (lib) => ({
    floor: lib.paving('#c6c0b4', '#7d776e'),
    wall: lib.plaster('#e2ddd4'),
    ceiling: lib.painted(0x2a2c33, 0.85),
    trim: lib.metal('#9aa1aa', 0.45, 0.7),
    floorTile: 1.2,
    wallTile: 1.8,
    view: { top: 0x86aede, bottom: 0xd6e0ec, sun: 0xf3e6cd },
  }),
};

const AGENCY_STYLE: InteriorStyle = {
  look: { ...LOOK_INTERIOR, exposure: 0.9, contrast: 1.05, bloomStrength: 0.28 },
  lighting: {
    ...ROOM_DAY,
    keyDirection: [-0.42, -0.6, 0.68],
    keyColor: 0xfff2e2,
    keyIntensity: 2.5,
    keyRadius: 13,
    ambientIntensity: 0.44,
    envTop: 0xb0c2d8, envSide: 0x74727a, envWindow: 0xdfeaff,
    fogNear: 34, fogFar: 140,
  },
  screen: [0xb06bff, 0x2f7bff],
  practicals: 0.85,
  shell: (lib) => ({
    floor: lib.carpet('#5c5a63'),
    wall: lib.plaster('#e0dcd4'),
    ceiling: lib.plaster('#f1efe9'),
    trim: lib.metal('#7f8087', 0.45, 0.6),
    floorTile: 1.3,
    wallTile: 2.2,
    view: { top: 0x7ea6d6, bottom: 0xcfdcea, sun: 0xf0e3ca },
  }),
};

export class LobbyScene extends InteriorScene {
  constructor() { super('residential_lobby', RESIDENTIAL_LOBBY, LOBBY_STYLE); }
}

export class StoreScene extends InteriorScene {
  constructor() { super('stream_store', STREAM_STORE, STORE_STYLE); }
}

export class AgencyScene extends InteriorScene {
  constructor() { super('agency_tower', AGENCY_TOWER, AGENCY_STYLE); }
}
