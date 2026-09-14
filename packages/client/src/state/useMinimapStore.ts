import { create } from 'zustand';
import type { SceneId } from '@streampolis/shared';

/**
 * O que o minimapa desenha, escrito pelo World a ~10 Hz. Só posições e
 * marcadores da CENA ATUAL — não há mapa mundial. Nada aqui é regra de jogo:
 * é o mundo contando à interface onde as coisas estão.
 */
export interface MapPoint { x: number; z: number }

export interface MinimapState {
  sceneId: SceneId | null;
  player: (MapPoint & { yaw: number }) | null;
  /** Portas da cena, com rótulo. */
  portals: Array<MapPoint & { id: string; label: string }>;
  /** O alvo da interação contextual (porta destacada ou personagem). */
  target: (MapPoint & { id: string }) | null;
  /** O amigo que se veio encontrar, se está nesta sala. */
  friend: (MapPoint & { name: string }) | null;
  /** A parada do bico em curso. */
  gig: MapPoint | null;
  /** Um personagem guiando o jogador: onde ele está e para onde vai. */
  guide: { npc: MapPoint & { name: string }; dest: MapPoint } | null;
  set(patch: Partial<Omit<MinimapState, 'set'>>): void;
}

export const useMinimapStore = create<MinimapState>((set) => ({
  sceneId: null, player: null, portals: [], target: null, friend: null, gig: null, guide: null,
  set: (patch) => set(patch),
}));

/** O nome da região, para o aviso de entrada. `tick` muda a cada entrada, mesmo na mesma cena. */
interface RegionState {
  name: string | null;
  tick: number;
  enter(name: string): void;
}

export const useRegionStore = create<RegionState>((set) => ({
  name: null,
  tick: 0,
  enter: (name) => set((s) => ({ name, tick: s.tick + 1 })),
}));
