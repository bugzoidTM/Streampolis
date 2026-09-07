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
  /**
   * A cena é hospedada por uma `CityRoom` — área pública, andável, shardada.
   *
   * Existe porque a lista estava escrita DUAS vezes: uma no game server (o que
   * a sala aceita) e outra no cliente (o que a URL pode pedir). Elas precisam
   * ser a mesma lista — quando divergem, o cliente pede um cenário que a sala
   * recusa e o jogador cai na praça sem nenhum erro na tela. Uma cena nova
   * agora é adicionada em um lugar só.
   */
  cityRoom: boolean;
}

export const SCENES: Record<SceneId, SceneDef> = {
  central_plaza:     { id: 'central_plaza',     name: 'Praça Central',    liveCapable: false, capacity: 36,  budgetMB: 8, outdoor: true,  cityRoom: true  },
  residential_lobby: { id: 'residential_lobby', name: 'Torre Residencial',liveCapable: false, capacity: 24,  budgetMB: 4, outdoor: false, cityRoom: true  },
  apartment:         { id: 'apartment',         name: 'Apartamento',      liveCapable: true,  capacity: 12,  budgetMB: 5, outdoor: false, cityRoom: false },
  stream_store:      { id: 'stream_store',      name: 'Stream Store',     liveCapable: false, capacity: 20,  budgetMB: 4, outdoor: false, cityRoom: true  },
  agency_tower:      { id: 'agency_tower',      name: 'Agency Tower',     liveCapable: false, capacity: 24,  budgetMB: 4, outdoor: false, cityRoom: true  },
  pk_arena:          { id: 'pk_arena',          name: 'PK Arena',         liveCapable: true,  capacity: 100, budgetMB: 6, outdoor: false, cityRoom: false },
  live_room:         { id: 'live_room',         name: 'Live Room',        liveCapable: true,  capacity: 100, budgetMB: 3, outdoor: false, cityRoom: false },
  // O bairro novo (PRD §34, "Novos bairros"). Cabe menos gente que a praça
  // apesar de ser rua aberta: a chuva, os néons e as poças custam preenchimento
  // por quadro, e uma rua a 12 fps não é atmosfera, é uma cena quebrada.
  noir_district:     { id: 'noir_district',     name: 'Distrito Sombra',  liveCapable: false, capacity: 24,  budgetMB: 7, outdoor: true,  cityRoom: true  },
};

export const SCENE_IDS = Object.keys(SCENES) as SceneId[];

/**
 * Os cenários que uma `CityRoom` hospeda.
 *
 * UMA lista, lida pelo game server (para recusar um `sceneId` que não é dele) e
 * pelo cliente (para não pedir na URL um cenário que a sala vai recusar). Eram
 * dois literais idênticos em pacotes diferentes, e o defeito que isso produz é
 * mudo: quem pedisse o cenário novo cairia na praça sem erro nenhum.
 */
export const CITY_SCENE_IDS: ReadonlySet<SceneId> = new Set(
  SCENE_IDS.filter((id) => SCENES[id].cityRoom),
);
