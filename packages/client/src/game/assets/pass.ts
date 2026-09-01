/**
 * O interruptor do passe de assets.
 *
 * Existe para uma comparação honesta: `?assets=0` desenha a praça procedural
 * de sempre e `?assets=1` desenha a mesma praça — mesmo layout, mesma colisão,
 * mesmo gameplay — com os modelos que passaram pelo passe. Trocar de visual
 * por recarregar a página é o que permite pôr HOJE e PASSE lado a lado sem
 * duas builds e sem acreditar na memória de ninguém.
 */
let forced: boolean | null = null;

export function setAssetPass(on: boolean | null) { forced = on; }

export function assetPassEnabled(): boolean {
  if (forced !== null) return forced;
  if (typeof location === 'undefined') return true;
  const v = new URLSearchParams(location.search).get('assets');
  return v === null ? true : v !== '0' && v !== 'false';
}
