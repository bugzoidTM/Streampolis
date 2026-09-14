/**
 * O relógio do mundo: um dia de 24 h que corre igual para todo mundo.
 *
 * Determinístico por construção: `minutos = ((agora − ÉPOCA) mod DIA) / DIA ×
 * 1440`. Não há estado a sincronizar entre processos — dois game servers com
 * o mesmo `WORLD_DAY_MINUTES` respondem a mesma hora para o mesmo instante, e
 * um que reinicia não "perde" tempo. Quem MANDA é o game server: ele escreve
 * `clock`/`clockRate` no estado da sala a cada segundo; cliente e worker dos
 * personagens só leem o que chega (o cálculo local aqui serve ao modo offline
 * do cliente e ao worker antes de ter uma sala).
 *
 * Um dia do mundo dura `WORLD_DAY_MINUTES` minutos reais (padrão 120: um
 * amanhecer e um anoitecer por sessão de duas horas). Com 1440 o relógio
 * acompanha o tempo real.
 */
export const WORLD_DAY_MINUTES_DEFAULT = 120;
/** Um instante fixo em que o mundo marcava 00:00. */
export const WORLD_CLOCK_EPOCH_MS = Date.UTC(2026, 8, 14, 0, 0, 0);
export const MINUTES_PER_DAY = 1440;

/** Minutos do mundo (0 ≤ m < 1440) num instante real. */
export function worldMinutesAt(nowMs: number, dayMinutes = WORLD_DAY_MINUTES_DEFAULT): number {
  const dayMs = Math.max(1, dayMinutes) * 60_000;
  const phase = (((nowMs - WORLD_CLOCK_EPOCH_MS) % dayMs) + dayMs) % dayMs;
  return (phase / dayMs) * MINUTES_PER_DAY;
}

/** Minutos do mundo por minuto real. */
export function worldClockRate(dayMinutes = WORLD_DAY_MINUTES_DEFAULT): number {
  return MINUTES_PER_DAY / Math.max(1, dayMinutes);
}

export function formatClock(minutes: number): string {
  const m = ((Math.floor(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Hora fracionária (0 ≤ h < 24). */
export function worldHour(minutes: number): number {
  return (((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60;
}

/** Noite = das 19 h às 6 h. É a mesma fronteira para rotina de personagem e para a cidade. */
export const NIGHT_FROM_H = 19;
export const NIGHT_TO_H = 6;

export function isNight(minutes: number): boolean {
  return hourWithin(worldHour(minutes), NIGHT_FROM_H, NIGHT_TO_H);
}

/** `h` está na janela [from, to) em horas, com volta pela meia-noite quando from > to. */
export function hourWithin(h: number, from: number, to: number): boolean {
  if (from === to) return true;
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/**
 * Quanto de luz do dia há (0 = noite fechada, 1 = pleno dia), com transições
 * suaves no amanhecer (5:30–7:30) e no anoitecer (17:30–19:30). É o que a
 * iluminação de rua usa para acender: lâmpada acende quando isto cai.
 */
export function daylight(minutes: number): number {
  const h = worldHour(minutes);
  const ramp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  if (h < 5.5 || h >= 19.5) return 0;
  if (h < 7.5) return ramp((h - 5.5) / 2);
  if (h < 17.5) return 1;
  return 1 - ramp((h - 17.5) / 2);
}
