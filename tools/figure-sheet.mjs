#!/usr/bin/env node
/**
 * Full-figure review sheet: one avatar variant per row, three yaws per row.
 *
 * The portrait sheet judges the face and the matrix judges geometry; neither
 * answers "does this read as a character?", which is a full-figure question at
 * a size where the silhouette, the shoulder line and the pose are all visible
 * at once. Hence a third sheet.
 *
 *   node tools/figure-sheet.mjs [--variants=0,1,2,3,4] [--yaws=0,0.6,1.6]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const out = args.out ?? 'shots/figure';
const w = Number(args.w ?? 420);
const h = Number(args.h ?? 640);
const yaws = (args.yaws ?? '0,0.7,1.7,3.14').split(',').map(Number);
const variants = (args.variants ?? '0,1,2,3,4').split(',').map(Number);
const anim = args.anim ?? 'idle';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = `${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0`
  + `&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.55}&dist=${args.dist ?? 2.6}`
  + `&cy=${args.cy ?? 0.95}&ly=${args.ly ?? 0.9}&start=${variants[0]}`;
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
await page.waitForTimeout(800);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const v of variants) {
  for (const yaw of yaws) {
    const png = await page.evaluate(([v, yaw, anim]) => {
      return window.__lab.figure ? window.__lab.figure(v, yaw, anim) : null;
    }, [v, yaw, anim]);
    if (!png) { console.error('no __lab.figure'); process.exit(2); }
    const file = path.join(out, `v${v}_y${yaw}.png`);
    await writeFile(file, Buffer.from(png.split(',')[1], 'base64'));
    console.log(file);
  }
}

if (errors.length) console.error(errors.slice(0, 5).join('\n'));
await browser.close();
