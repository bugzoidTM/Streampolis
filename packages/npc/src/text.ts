/** Sem acento, minúsculo, para casar nome e lugar com o que se digita no chat. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
