import { create } from 'zustand';
import type { Weather } from '@streampolis/shared';

/**
 * O relógio do mundo como a sala o publicou, para o HUD. O World escreve no
 * máximo uma vez por segundo (e só quando o minuto muda); a UI só desenha.
 */
interface ClockState {
  /** Minutos do dia, ou nulo antes da primeira escrita da sala. */
  minutes: number | null;
  /** O clima do mundo como a sala o publicou. */
  weather: Weather | null;
  set(minutes: number | null): void;
  setWeather(weather: Weather | null): void;
}

export const useClockStore = create<ClockState>((set) => ({
  minutes: null,
  weather: null,
  set: (minutes) => set((s) => (s.minutes === minutes ? s : { minutes })),
  setWeather: (weather) => set((s) => (s.weather === weather ? s : { weather })),
}));
