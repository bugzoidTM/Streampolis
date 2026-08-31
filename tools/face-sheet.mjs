#!/usr/bin/env node
/**
 * Portrait review loop for the face.
 *
 * A face is judged at portrait scale or not at all: every defect that matters
 * — a nose that vanishes in profile, a smile that only reads head-on, a catch
 * light in the wrong eye — is invisible in a full-body tile. Renders each face
 * preset in each expression at three yaws and stitches one sheet.
 *
 *   node tools/face-sheet.mjs [--out=shots/face] [--yaws=0,0.5,1.1]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const out = args.out ?? 'shots/face';
const size = Number(args.size ?? 420);
const yaws = (args.yaws ?? '0,0.55,1.15').split(',').map(Number);
const expressions = (args.expressions ?? 'neutral,smile,surprise,focus').split(',');
const faces = (args.faces ?? '0,1,2,3').split(',').map(Number);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: size, height: size } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = `${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&matrix=1&spin=0&yaw=0&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.5}`;
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
await page.waitForTimeout(1000);

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'tiles'), { recursive: true });

const SKIN = [1, 5, 3, 6];
// Hair off by default: the current shell is a sphere that ignores the skull
// sculpt and hides two thirds of the face, so judging a face through it is
// judging the hair. `--hair=1` puts it back on.
const HAIR = args.hair === '1'
  ? ['hair_bob_01', 'hair_buzz_01', 'hair_ponytail_01', 'hair_afro_01']
  : ['', '', '', ''];
const rows = [];

for (const f of faces) {
  for (const yaw of yaws) {
    const cells = [];
    for (const e of expressions) {
      const png = await page.evaluate(
        ([cfg, expr, y]) => window.__lab.portrait(cfg, expr, y),
        [{ facePreset: f, bodyPreset: f, skinTone: SKIN[f % 4], hair: HAIR[f % 4], hairColor: f }, e, yaw],
      );
      const file = path.join('tiles', `f${f}_y${String(yaw).replace('.', '')}_${e}.png`);
      await writeFile(path.join(out, file), Buffer.from(png.split(',')[1], 'base64'));
      cells.push({ file, label: e });
      process.stdout.write('·');
    }
    rows.push({ label: `rosto ${f} · giro ${yaw.toFixed(2)}`, cells });
  }
}
process.stdout.write('\n');

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#0b0d12; color:#e8e6e1; font:11px ui-monospace,monospace; }
  h1 { font:600 15px system-ui,sans-serif; padding:14px 16px 8px; margin:0; }
  .row { display:grid; grid-template-columns:120px repeat(${expressions.length}, 1fr); gap:4px; padding:0 12px 4px; align-items:center; }
  .row > b { font:600 11px system-ui,sans-serif; color:#9aa0ad; }
  figure { margin:0; background:#11141f; border:1px solid #232838; border-radius:6px; overflow:hidden; }
  img { display:block; width:100%; }
  figcaption { padding:3px; text-align:center; color:#6f7686; }
</style>
<h1>Rosto — ${faces.length} presets × ${expressions.length} expressões × ${yaws.length} giros</h1>
${rows.map((r) => `<div class="row"><b>${r.label}</b>${r.cells.map((c) =>
  `<figure><img src="${c.file}"><figcaption>${c.label}</figcaption></figure>`).join('')}</div>`).join('')}`;

await writeFile(path.join(out, 'sheet.html'), html);
const sheet = await browser.newPage({ viewport: { width: 120 + expressions.length * 260, height: 1000 } });
await sheet.goto(`file://${path.resolve(path.join(out, 'sheet.html'))}`, { waitUntil: 'load' });
await sheet.screenshot({ path: path.join(out, 'sheet.png'), fullPage: true });
await browser.close();

console.log(JSON.stringify({ tiles: rows.length * expressions.length, errors: errors.slice(0, 5) }, null, 2));
