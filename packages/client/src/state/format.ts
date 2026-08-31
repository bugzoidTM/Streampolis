/** pt-BR formatting helpers shared by every screen. */

const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat('pt-BR');

/** 2841 -> "2,8 mil". Used wherever a number must not wrap a layout. */
export const short = (n: number): string => (n < 1000 ? plain.format(n) : compact.format(n));

export const full = (n: number): string => plain.format(n);

/** 74_000 -> "1:14". Always mm:ss so the PK timer never changes width. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 4_934_000 -> "1h22". Duration in the end-of-live report. */
export function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m} min`;
}

/** "há 41 min" — relative age of a live. */
export function since(ts: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return `há ${h}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`;
}
