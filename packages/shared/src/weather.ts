import { WORLD_DAY_MINUTES_DEFAULT, worldMinutesAt, MINUTES_PER_DAY, WORLD_CLOCK_EPOCH_MS } from './clock.js';

/**
 * O clima do mundo: um estado só, `clear` ou `rain`, igual para todo mundo.
 *
 * Mesma disciplina do relógio: o game server ESCOLHE e escreve `weather` no
 * estado da sala; cliente (efeitos) e worker (rotina) só leem. A escolha é
 * determinística do tempo — o dia do mundo é dividido em janelas de 3 h do
 * mundo e cada janela tem um sorteio fixo (hash do índice), com ~30 % de
 * chuva — para dois game servers concordarem sem falar um com o outro. Um
 * operador força com `WORLD_WEATHER=rain|clear`. Sem tempestade: chuva é
 * chuva, sem raio, sem vento, sem mudança de regra de jogo.
 */
export type Weather = 'clear' | 'rain';

/** Janela de clima em minutos do mundo (3 h = 15 min reais com o dia de 120 min). */
export const WEATHER_SLOT_MINUTES = 180;
export const RAIN_CHANCE = 0.3;

function hash32(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** O índice da janela de clima num instante real (conta desde a época, atravessando dias). */
export function weatherSlotAt(nowMs: number, dayMinutes = WORLD_DAY_MINUTES_DEFAULT): number {
  const worldMinutesSinceEpoch = ((nowMs - WORLD_CLOCK_EPOCH_MS) / (Math.max(1, dayMinutes) * 60_000)) * MINUTES_PER_DAY;
  return Math.floor(worldMinutesSinceEpoch / WEATHER_SLOT_MINUTES);
}

export function weatherOfSlot(slot: number): Weather {
  return (hash32(slot) % 1000) / 1000 < RAIN_CHANCE ? 'rain' : 'clear';
}

/** O clima num instante real, ou o forçado pelo operador. */
export function weatherAt(nowMs: number, dayMinutes = WORLD_DAY_MINUTES_DEFAULT, forced: string | undefined = undefined): Weather {
  if (forced === 'rain' || forced === 'clear') return forced;
  return weatherOfSlot(weatherSlotAt(nowMs, dayMinutes));
}

/** Quantos minutos do mundo faltam para a janela atual acabar (para o painel). */
export function weatherMinutesLeft(nowMs: number, dayMinutes = WORLD_DAY_MINUTES_DEFAULT): number {
  const m = worldMinutesAt(nowMs, dayMinutes);
  return WEATHER_SLOT_MINUTES - (m % WEATHER_SLOT_MINUTES);
}

export function isWeather(x: unknown): x is Weather {
  return x === 'clear' || x === 'rain';
}
