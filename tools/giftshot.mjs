/**
 * Fotografa o efeito de um presente. Dispara pelo caminho de preview (sem
 * economia) e captura alguns instantes depois, porque o que interessa é o meio
 * da animação, não o quadro do disparo.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const url = args.url ?? 'http://127.0.0.1:5273/?view=world&scene=central_plaza';
const gift = args.gift ?? 'g_rose';
const quantity = Number(args.q ?? 1);
const delay = Number(args.delay ?? 700);
const out = args.out ?? `shots/gift_${gift}.png`;

const browser = await chromium.launch({ args: [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--disable-dev-shm-usage',
] });
const page = await browser.newPage({ viewport: { width: Number(args.w ?? 900), height: Number(args.h ?? 760) } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 }).catch(() => errors.push('sem __ready'));
await page.waitForTimeout(1500);

const fired = await page.evaluate(([id, q]) => window.__lab?.gift?.(id, q) ?? false, [gift, quantity]);
await page.waitForTimeout(delay);
const stats = await page.evaluate(() => window.__lab?.stats?.() ?? null);

await mkdir(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, timeout: 120_000 });
await writeFile(out.replace(/\.png$/, '.json'), JSON.stringify({ gift, quantity, fired, stats, errors }, null, 2));
console.log(JSON.stringify({ out, fired, particles: stats?.particles, errors }, null, 2));
await browser.close();
