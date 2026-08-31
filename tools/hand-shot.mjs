#!/usr/bin/env node
/**
 * Close-up review loop for the hands.
 *
 * Same reason the face has its own sheet: five fingers are invisible at body
 * scale, and a defect nobody can see is a defect nobody fixes. Renders the
 * left hand of each body preset from the front and from the side.
 *
 *   node tools/hand-shot.mjs [--out=shots/hand] [--bodies=0,1,2,3]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const out = args.out ?? 'shots/hand';
const size = Number(args.size ?? 460);
const bodies = (args.bodies ?? '0,1,2,3').split(',').map(Number);
const views = [['frente', 0], ['lado', 1.25], ['costas', 3.0]];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: size, height: size } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&matrix=1&spin=0&yaw=0&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.5}`,
  { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
await page.waitForTimeout(800);

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'tiles'), { recursive: true });

const rows = [];
for (const b of bodies) {
  const cells = [];
  for (const [name, yaw] of views) {
    const png = await page.evaluate(
      ([cfg, y]) => window.__lab.handShot(cfg, y),
      [{ bodyPreset: b, top: '', bottom: '', shoes: '', hair: '' }, yaw],
    );
    const file = path.join('tiles', `b${b}_${name}.png`);
    await writeFile(path.join(out, file), Buffer.from(png.split(',')[1], 'base64'));
    cells.push({ file, label: name });
    process.stdout.write('·');
  }
  rows.push({ label: `corpo ${b}`, cells });
}
process.stdout.write('\n');

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#0b0d12; color:#e8e6e1; font:11px ui-monospace,monospace; }
  h1 { font:600 15px system-ui,sans-serif; padding:14px 16px 8px; margin:0; }
  .row { display:grid; grid-template-columns:90px repeat(${views.length}, 1fr); gap:4px; padding:0 12px 4px; align-items:center; }
  .row > b { font:600 11px system-ui,sans-serif; color:#9aa0ad; }
  figure { margin:0; background:#11141f; border:1px solid #232838; border-radius:6px; overflow:hidden; }
  img { display:block; width:100%; }
  figcaption { padding:3px; text-align:center; color:#6f7686; }
</style>
<h1>Mãos — ${bodies.length} corpos × ${views.length} vistas</h1>
${rows.map((r) => `<div class="row"><b>${r.label}</b>${r.cells.map((c) =>
  `<figure><img src="${c.file}"><figcaption>${c.label}</figcaption></figure>`).join('')}</div>`).join('')}`;

await writeFile(path.join(out, 'sheet.html'), html);
const sheet = await browser.newPage({ viewport: { width: 90 + views.length * 280, height: 1000 } });
await sheet.goto(`file://${path.resolve(path.join(out, 'sheet.html'))}`, { waitUntil: 'load' });
await sheet.screenshot({ path: path.join(out, 'sheet.png'), fullPage: true });
await browser.close();
console.log(JSON.stringify({ tiles: rows.length * views.length, errors: errors.slice(0, 5) }, null, 2));
