/**
 * Fumaça da produção: a experiência de quem chega sem link, sem token e sem
 * conta. Abre o site público, escolhe um personagem, entra no mundo e confere
 * que a sala é real (não o modo offline disfarçado).
 *
 * `node tools/prod-check.mjs [--url=https://streampolis.nutef.com]`
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const URL_BASE = args.url ?? 'https://streampolis.nutef.com';
const dir = args.out ?? 'shots/prod';

const checks = [];
const errors = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

await mkdir(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log(`\n1) Primeira visita a ${URL_BASE}`);
await page.goto(URL_BASE, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForSelector('.enter__title', { timeout: 30_000 });
check('a porta de entrada aparece', true);

await page.waitForFunction(() => document.querySelectorAll('.cast__art img').length > 0, { timeout: 60_000 })
  .then(() => check('os personagens aparecem com o retrato 3D de cada um', true))
  .catch(() => check('os personagens aparecem com o retrato 3D de cada um', false));
const cast = await page.locator('.cast__name').allInnerTexts();
check('há mais de um personagem para escolher', cast.length > 1, cast.join(', '));
await page.waitForTimeout(500);
await page.screenshot({ path: `${dir}/entrada.png` });

console.log('\n2) Entrar como o primeiro personagem');
await page.locator('.cast').first().click();
await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 })
  .catch(() => errors.push('sem __ready'));
await page.waitForTimeout(2_500);

const stats = await page.evaluate(() => window.__lab?.stats?.() ?? null);
check('o mundo carregou', Boolean(stats), stats ? `cena ${stats.scene}` : 'sem stats');
check('a sessão é online (sala de verdade, não offline)', stats?.online === true);
check('o avatar do jogador está em cena', (stats?.actors ?? 0) >= 1);
await page.screenshot({ path: `${dir}/mundo.png` });

console.log('\n3) A sessão sobrevive a um recarregamento');
await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(1_500);
const again = await page.evaluate(() => window.__lab?.stats?.() ?? null);
check('voltou direto para o mundo, sem pedir personagem de novo', again?.online === true);

if (errors.length) console.log('\nErros de console:', errors.slice(0, 6));
const failed = checks.filter((c) => !c).length;
console.log(failed === 0
  ? `\n✅ ${checks.length}/${checks.length} verificações passaram. Capturas em ${dir}/`
  : `\n❌ ${failed} de ${checks.length} falharam.`);

await browser.close();
process.exit(failed === 0 ? 0 : 1);
