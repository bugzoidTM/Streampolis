import { create } from 'zustand';

/**
 * O relógio do mundo como a sala o publicou, para o HUD. O World escreve no
 * máximo uma vez por segundo (e só quando o minuto muda); a UI só desenha.
 */
interface ClockState {
  /** Minutos do dia, ou nulo antes da primeira escrita da sala. */
  minutes: number | null;
  set(minutes: number | null): void;
}

export const useClockStore = create<ClockState>((set) => ({
  minutes: null,
  set: (minutes) => set((s) => (s.minutes === minutes ? s : { minutes })),
}));
