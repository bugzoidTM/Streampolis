import type { SceneId } from './types.js';

export interface SceneDef {
  id: SceneId;
  name: string;
  /** Rooms that can host a live broadcast (PRD §10). */
  liveCapable: boolean;
  /** Target player capacity before sharding (SPECs §17). */
  capacity: number;
  /** Approximate download budget in MB, compressed (SPECs §44). */
  budgetMB: number;
  outdoor: boolean;
}

export const SCENES: Record<SceneId, SceneDef> = {
  central_plaza:     { id: 'central_plaza',     name: 'Praça Central',    liveCapable: false, capacity: 36,  budgetMB: 8, outdoor: true },
  residential_lobby: { id: 'residential_lobby', name: 'Torre Residencial',liveCapable: false, capacity: 24,  budgetMB: 4, outdoor: false },
  apartment:         { id: 'apartment',         name: 'Apartamento',      liveCapable: true,  capacity: 12,  budgetMB: 5, outdoor: false },
  stream_store:      { id: 'stream_store',      name: 'Stream Store',     liveCapable: false, capacity: 20,  budgetMB: 4, outdoor: false },
  agency_tower:      { id: 'agency_tower',      name: 'Agency Tower',     liveCapable: false, capacity: 24,  budgetMB: 4, outdoor: false },
  pk_arena:          { id: 'pk_arena',          name: 'PK Arena',         liveCapable: true,  capacity: 100, budgetMB: 6, outdoor: false },
  live_room:         { id: 'live_room',         name: 'Live Room',        liveCapable: true,  capacity: 100, budgetMB: 3, outdoor: false },
};

export const SCENE_IDS = Object.keys(SCENES) as SceneId[];
