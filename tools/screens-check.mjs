/**
 * Prova das telas de produto: feed, perfil e loja, num navegador de verdade e
 * contra a API de verdade.
 *
 * Beto abre uma live headless (com token assinado pela API, então ela entra no
 * banco e aparece no feed). Ana entra pelo cliente e navega: Lives → Perfil →
 * Loja, comprando uma peça no caminho. Cada aba vira uma captura em shots/.
 *
 * Precisa dos três processos no ar: API (:8787), game server apontado para ela
 * e Vite (:5273).
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';
import { mkdir } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';
const dir = args.out ?? 'shots/screens';

const checks = [];
const errors = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function login(username) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou (${res.status})`);
  return res.json();
}

await mkdir(dir, { recursive: true });

console.log('\n1) Beto abre uma live (headless) para o feed ter conteúdo');
const beto = await login('beto');
const betoClient = new Client(SERVER);
const betoLive = await betoClient.create('live', {
  token: beto.token, title: 'Sessão de sexta 💜', category: 'Música', sceneId: 'live_room',
});
await new Promise((r) => setTimeout(r, 1200));
const feedRows = await (await fetch(`${API}/lives`)).json();
check('a live está no feed da API', (feedRows.lives ?? []).some((l) => l.roomId === betoLive.roomId));
check('o feed traz a aparência do host', (feedRows.lives ?? []).every((l) => l.hostAvatar));

console.log('\n2) Ana entra no cliente');
const ana = await login('ana');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${CLIENT}/?view=world&token=${ana.token}&name=Ana`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 }).catch(() => errors.push('sem __ready'));
await page.waitForTimeout(1_500);
check('a navegação está montada', await page.locator('.nav').isVisible());

console.log('\n3) Feed');
await page.getByRole('button', { name: 'Lives' }).click();
await page.waitForSelector('.feed__grid .card', { timeout: 20_000 }).catch(() => {});
// O retrato 3D entra pela fila; espera o primeiro chegar antes de fotografar.
await page.waitForFunction(() => document.querySelector('.card__poster') !== null, { timeout: 30_000 })
  .then(() => check('o card mostra o avatar do host renderizado em 3D', true))
  .catch(() => check('o card mostra o avatar do host renderizado em 3D', false));
await page.waitForTimeout(600);
await page.screenshot({ path: `${dir}/feed.png` });

console.log('\n4) Perfil');
await page.getByRole('button', { name: 'Perfil' }).click();
await page.waitForSelector('.profile__name', { timeout: 20_000 });
await page.waitForFunction(() => document.querySelector('.profile__poster img') !== null, { timeout: 30_000 })
  .catch(() => errors.push('retrato do perfil não chegou'));
const fame = await page.locator('.profile__counts').innerText();
check('o perfil mostra números do servidor', /\d/.test(fame), fame.replace(/\n/g, ' '));
await page.screenshot({ path: `${dir}/perfil.png` });

console.log('\n5) Loja');
// Prazo LARGO neste clique, e não é frouxidão: abrir a Loja monta um avatar
// completo por peça no `PosterStudio`, em série, na thread principal — 45
// retratos 3D. Numa GPU isso é rápido; neste ambiente headless, que rasteriza
// por software, medimos 53 s. O padrão de 30 s do Playwright reprovava uma
// tela que funciona.
await page.getByRole('button', { name: 'Loja' }).click({ timeout: 180_000 });
await page.waitForSelector('.store__grid .item', { timeout: 20_000 });
await page.waitForFunction(() => document.querySelector('.item__art img') !== null, { timeout: 30_000 })
  .then(() => check('a peça aparece vestida no avatar de quem olha', true))
  .catch(() => check('a peça aparece vestida no avatar de quem olha', false));
await page.waitForTimeout(400);
await page.screenshot({ path: `${dir}/loja.png` });

// Compra de verdade: preço e saldo são do servidor.
const walletBefore = (await (await fetch(`${API}/me`, { headers: { authorization: `Bearer ${ana.token}` } })).json()).wallet;
const target = page.locator('.item:not(.is-owned)').first();
const targetName = await target.locator('.item__name').innerText();
await target.locator('button').first().click();
await page.waitForSelector('.store__confirmBox', { timeout: 10_000 });
await page.getByRole('button', { name: 'Confirmar' }).click();
await page.waitForSelector('.store__toast', { timeout: 15_000 });
const toast = await page.locator('.store__toast').innerText();
await page.waitForTimeout(300);
await page.screenshot({ path: `${dir}/loja-compra.png` });

const walletAfter = (await (await fetch(`${API}/me`, { headers: { authorization: `Bearer ${ana.token}` } })).json()).wallet;
check(
  'a compra saiu da carteira no servidor',
  walletAfter.credits < walletBefore.credits || walletAfter.coins < walletBefore.coins,
  `${targetName}: ${walletBefore.credits}→${walletAfter.credits} credits, ${walletBefore.coins}→${walletAfter.coins} coins (${toast})`,
);

console.log('\n6) Do feed para dentro da live');
await page.getByRole('button', { name: 'Lives' }).click();
await page.waitForSelector('.card__art', { timeout: 20_000 });
await page.locator('.card__art').first().click();
await page.waitForFunction(() => document.querySelector('.live') !== null, { timeout: 40_000 })
  .then(() => check('tocar no card entra na sala da live', true))
  .catch(() => check('tocar no card entra na sala da live', false));
await page.waitForTimeout(2_000);
await page.screenshot({ path: `${dir}/live-do-feed.png` });

if (errors.length) console.log('\nErros de console:', errors.slice(0, 6));
const failed = checks.filter((c) => !c).length;
console.log(failed === 0
  ? `\n✅ ${checks.length}/${checks.length} verificações passaram. Capturas em ${dir}/`
  : `\n❌ ${failed} de ${checks.length} falharam.`);

await betoLive.leave();
await browser.close();
process.exit(failed === 0 ? 0 : 1);
