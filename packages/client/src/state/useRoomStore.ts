import { create } from 'zustand';
import type { AvatarConfig } from '@streampolis/shared';

/**
 * Quem está na sala AGORA.
 *
 * Um mundo multiplayer em que não dá para saber quem está por perto é um mundo
 * de estranhos de costas: o PRD §6 pede da praça "encontrar jogadores... ver
 * perfis, seguir", e as três coisas começam por uma lista de nomes.
 *
 * A regra de ouro desta store é a frequência. O estado da sala chega a ~20 Hz
 * e traz sobretudo POSIÇÃO; escrever a lista a cada patch faria o React
 * redesenhar o painel vinte vezes por segundo para mostrar exatamente os mesmos
 * nomes. Quem alimenta (`network/bridge.ts`) só escreve quando a COMPOSIÇÃO
 * muda — alguém entrou, saiu, trocou de nome, de papel ou de roupa.
 */

export interface RoomPerson {
  /** Id do usuário: é ele que abre um perfil. */
  userId: string;
  sessionId: string;
  name: string;
  gifterLevel: number;
  /** XP do PISO do nível: o selo é desenhado em XP e a rede manda nível. */
  gifterXp: number;
  agency: string | null;
  role: 'visitor' | 'owner' | 'host' | 'cohost' | 'spectator';
  isSelf: boolean;
  avatar: AvatarConfig;
}

interface RoomState {
  people: RoomPerson[];
  /** Assinatura da composição atual; existe para o bridge não reescrever à toa. */
  signature: string;
  setPeople: (people: RoomPerson[], signature: string) => void;
  clear: () => void;
}

export const useRoomStore = create<RoomState>((set) => ({
  people: [],
  signature: '',
  setPeople: (people, signature) => set({ people, signature }),
  clear: () => set({ people: [], signature: '' }),
}));
