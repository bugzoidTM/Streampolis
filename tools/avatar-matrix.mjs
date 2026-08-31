#!/usr/bin/env node
/**
 * Regression gate for the avatar.
 *
 * Renders and MEASURES every combination of body, top, bottom and shoe: the
 * gap between the two shoes, the gap between the legs below the knee, and any
 * skin protruding through a garment. Writes one PNG per combination, a contact
 * sheet and a JSON report, and exits non-zero if any combination is broken.
 *
 * No new garment enters the wardrobe while this is red — a garment inherits
 * the body it is lofted from, so a broken body ships a broken catalogue.
 *
 *   node tools/avatar-matrix.mjs [--url=…] [--out=shots/matrix] [--group=core]
 *                               [--no-images] [--tiles] [--limit=N] [--index=33,34]
 *                               [--label=<regex sobre o rótulo>]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'];
  }),
);

const base = args.url ?? 'http://127.0.0.1:5273/';
const out = args.out ?? 'shots/matrix';
const group = args.group ?? 'all';
const withImages = args['no-images'] !== 'true';
const keepTiles = args.tiles === 'true';
const limit = args.limit ? Number(args.limit) : Infinity;
const tileW = Number(args.tw ?? 320);
const tileH = Number(args.th ?? 500);

const url = `${base}?view=lab&matrix=1&spin=0&yaw=${args.yaw ?? 0.28}&tier=${args.tier ?? 'medium'}`;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: tileW, height: tileH } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
await page.waitForTimeout(1200);

const limits = await page.evaluate(() => window.__lab.limits());
const all = await page.evaluate(() => window.__lab.matrix());
const pick = args.index ? new Set(args.index.split(',').map(Number)) : null;
const label = args.label ? new RegExp(args.label) : null;
const wanted = all
  .filter((e) => (group === 'all' || e.group === group)
    && (!pick || pick.has(e.index))
    && (!label || label.test(e.label)))
  .slice(0, limit);

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'tiles'), { recursive: true });

const results = [];
const started = Date.now();

for (const entry of wanted) {
  const tile = await page.evaluate(
    ([i, img]) => window.__lab.tile(i, img),
    [entry.index, withImages],
  );
  if (!tile) { errors.push(`combinação ${entry.index} não construiu`); continue; }

  let file = null;
  if (tile.png) {
    file = path.join('tiles', `${String(entry.index).padStart(3, '0')}.png`);
    await writeFile(path.join(out, file), Buffer.from(tile.png.split(',')[1], 'base64'));
  }
  results.push({ ...entry, file, audit: tile.audit, bounds: tile.bounds });

  const mark = tile.audit.ok ? '·' : '✗';
  process.stdout.write(mark);
  if (results.length % 60 === 0) process.stdout.write(` ${results.length}/${wanted.length}\n`);
}
process.stdout.write('\n');

const failed = results.filter((r) => !r.audit.ok);
const worst = {
  shoeGap: Math.min(...results.map((r) => r.audit.shoeGap)),
  legGap: Math.min(...results.map((r) => r.audit.legGap)),
  skinLeakDepth: Math.max(...results.map((r) => r.audit.skinLeakDepth)),
};

const report = {
  url,
  ran: new Date().toISOString(),
  seconds: +((Date.now() - started) / 1000).toFixed(1),
  limits,
  total: results.length,
  failed: failed.length,
  worst,
  failures: failed.map((r) => ({ label: r.label, why: r.audit.failures, audit: r.audit })),
  results,
  errors,
};
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

// Contact sheet: the numbers say what broke, the sheet says what it looks like.
if (withImages && results.length) {
  const cols = Number(args.cols ?? 12);
  const cards = results.map((r) => `
    <figure class="${r.audit.ok ? 'ok' : 'bad'}">
      <img src="${r.file}">
      <figcaption>${r.label}<br><span>pé ${(r.audit.shoeGap * 1000).toFixed(0)} · vão ${(r.audit.legGap * 1000).toFixed(0)} · pele ${r.audit.skinLeaks}</span></figcaption>
    </figure>`).join('');

  const sheetHtml = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #0b0d12; color: #e8e6e1;
           font: 11px/1.35 ui-monospace, monospace; }
    h1 { font: 600 15px/1.4 system-ui, sans-serif; padding: 14px 16px 0; margin: 0; }
    p  { padding: 2px 16px 12px; margin: 0; color: #9aa0ad; }
    .grid { display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 4px; padding: 0 12px 16px; }
    figure { margin: 0; background: #11141f; border: 1px solid #232838; border-radius: 6px; overflow: hidden; }
    figure.bad { border-color: #ff2d6f; box-shadow: inset 0 0 0 1px #ff2d6f; }
    img { display: block; width: 100%; }
    figcaption { padding: 3px 4px 5px; text-align: center; font-size: 9px; }
    figcaption span { color: #6f7686; }
    .bad figcaption span { color: #ff8fb2; }
  </style>
  <h1>Matriz do avatar — ${results.length} combinações, ${failed.length} quebradas</h1>
  <p>pé = folga entre calçados (mm, mínimo ${limits.shoeGap * 1000}) · vão = entre as pernas (mm, mínimo ${limits.legGap * 1000}) · pele = raios com pele fora da roupa</p>
  <div class="grid">${cards}</div>`;

  const sheetFile = path.join(out, 'sheet.html');
  await writeFile(sheetFile, sheetHtml);
  const sheetPage = await browser.newPage({ viewport: { width: cols * 168, height: 1000 } });
  await sheetPage.goto(`file://${path.resolve(sheetFile)}`, { waitUntil: 'load' });
  await sheetPage.screenshot({ path: path.join(out, 'sheet.png'), fullPage: true });
  await sheetPage.close();
}

await browser.close();
if (!keepTiles && !withImages) await rm(path.join(out, 'tiles'), { recursive: true, force: true });

console.log(JSON.stringify({
  total: report.total, failed: report.failed, worst, seconds: report.seconds,
  errors: errors.slice(0, 5),
  piores: report.failures.slice(0, 8).map((f) => `${f.label}: ${f.why.join('; ')}`),
}, null, 2));

process.exit(failed.length || errors.length ? 1 : 0);
