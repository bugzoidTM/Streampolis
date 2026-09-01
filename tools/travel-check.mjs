#!/usr/bin/env node
/**
 * Prova que dá para IR a algum lugar (PRD §6, "acessar outros locais").
 *
 * Até aqui as salas existiam e o único jeito de trocar de uma para a outra era
 * editar a URL. Três metades disto falham separadamente: o marcador pode não
 * existir, o alcance pode não disparar, e a viagem pode abrir a sala errada
 * (já aconteceu neste projeto — toda intenção virava CityRoom).
 *
 * A prova acontece DENTRO da loja, e não atravessando a praça, por um motivo
 * de medição: neste ambiente headless a cena da praça roda a poucos quadros
 * por segundo e andar dezesseis metros levaria minutos de teste. A porta de
 * saída da loja fica a dois passos de onde se nasce nela, o que exercita a
 * mesma cadeia inteira em segundos — e a proximidade ainda é medida de
 * verdade, andando para longe dela e voltando.
 *
 *   node tools/travel-check.mjs
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const r = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ana' }),
});
const { token } = await r.json();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 580 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const stats = () => page.evaluate(() => window.__lab.stats());
const prompt = () => page.locator('.portal__label').first().textContent().catch(() => null);

console.log('\n1) A praça tem portas');
await page.goto(`${CLIENT}/?scene=central_plaza&token=${token}&tier=low`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
await page.waitForTimeout(600);
const plaza = await stats();
check('a praça publica três destinos', plaza.portals === 3, `${plaza.portals}`);
check('nascer no meio da praça não oferece viagem nenhuma', plaza.portal === null);
await page.screenshot({ path: 'shots/portal-praca.png', timeout: 120_000 });

console.log('\n2) Dentro da loja, a porta de volta');
await page.goto(`${CLIENT}/?scene=stream_store&token=${token}&tier=low`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
await page.waitForTimeout(900);
const store = await stats();
check('a loja tem uma porta', store.portals === 1, `${store.portals}`);
check('ela está ao alcance de quem acabou de entrar', store.portal === 'stream_store_exit',
  store.portal ?? 'nenhuma');
check('o aviso diz para onde leva', (await prompt()) === 'Voltar à praça');
await page.screenshot({ path: 'shots/portal-loja.png', timeout: 120_000 });

console.log('\n3) O alcance é distância, não estado');
// Anda para longe da porta e o convite tem de sumir. É o que separa "existe um
// portal" de "o portal reage ao corpo do jogador".
//
// Os tempos são generosos porque a medição é honesta sobre o ambiente: aqui o
// jogo roda a poucos quadros por segundo sobre rasterização por software, e o
// avatar anda muito mais devagar do que andaria num navegador com GPU.
const DOOR = { x: 0, z: 18 / 2 - 1.5 };
const far = async () => {
  const s = await stats();
  return Math.hypot((s.player?.x ?? 0) - DOOR.x, (s.player?.z ?? 0) - DOOR.z);
};
const hold = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

let bestKey = null;
let bestGain = 0;
for (const key of ['w', 'a', 's', 'd']) {
  const before = await far();
  await hold(key, 1200);
  const gain = (await far()) - before;
  if (gain > bestGain) { bestGain = gain; bestKey = key; }
}
check('alguma direção afasta da porta', bestKey !== null, bestKey ?? 'nenhuma');

for (let i = 0; i < 12 && (await far()) < 2.8 && bestKey; i++) await hold(bestKey, 1500);
const d = await far();
const aviso = await prompt();
const estado = (await stats()).portal;
check('longe da porta, o convite some', d <= 2.2 ? false : estado === null && aviso === null,
  `${d.toFixed(2)} m do portal`);

console.log('\n4) Entrar leva de volta à praça');
await page.goto(`${CLIENT}/?scene=stream_store&token=${token}&tier=low`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
await page.waitForTimeout(900);
await page.keyboard.press('e');
const voltou = await page
  .waitForFunction(() => window.__lab.stats()?.scene === 'central_plaza', null, { timeout: 180_000 })
  .then(() => true).catch(() => false);
check('a cena virou a praça', voltou);
if (voltou) {
  const online = (await stats()).online;
  check('e a sala nova é uma sala de verdade, não o modo offline', online === true);
}

await browser.close();
const ok = results.filter(Boolean).length;
if (errors.length) console.log('\nerros no console:', errors.slice(0, 5));
console.log(`\n${ok === results.length ? '✅' : '❌'} ${ok}/${results.length} verificações passaram.`);
process.exit(ok === results.length ? 0 : 1);
