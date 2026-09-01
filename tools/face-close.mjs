#!/usr/bin/env node
/**
 * O tribunal do rosto: close frontal, três quartos e perfil, com câmera e luz
 * FIXAS.
 *
 * A folha de expressões (`face-sheet.mjs`) responde "esta expressão lê?"; esta
 * responde outra pergunta, que é a que estava sem ferramenta: **este rosto é
 * agradável?** Ela é de proporção e de silhueta, e só se responde grande, nos
 * três ângulos, com nada mudando entre um antes e um depois — mesma luz, mesma
 * distância, mesmo recorte. Uma comparação em que a câmera também mudou não
 * prova nada.
 *
 * Cada rodada escreve `sheet.png` e os tiles soltos. Para comparar:
 *
 *   node tools/face-close.mjs --out=shots/face-antes
 *   ...mexer no rosto...
 *   node tools/face-close.mjs --out=shots/face-depois
 *   node tools/face-close.mjs --diff=shots/face-antes,shots/face-depois
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const OUT = args.out ?? 'shots/face-close';
const SIZE = Number(args.size ?? 760);
const FACES = (args.faces ?? '0,2').split(',').map(Number);
const HAIR = (args.hair ?? 'hair_bob_01,hair_ponytail_01').split(',');
const SKIN = (args.skin ?? '1,5').split(',').map(Number);
/** Frontal, três quartos, perfil. O 3/4 é o ângulo em que um rosto mente menos. */
const VIEWS = [
  { yaw: 0, label: 'frontal' },
  { yaw: 0.68, label: 'três quartos' },
  { yaw: 1.57, label: 'perfil' },
];

// Modo comparação: monta uma folha com as duas rodadas lado a lado, sem abrir
// navegador nenhum.
if (args.diff) {
  const [a, b] = args.diff.split(',');
  const rows = [];
  for (const f of FACES) {
    for (const dir of [a, b]) {
      rows.push({
        label: `rosto ${f} · ${path.basename(dir)}`,
        cells: VIEWS.map((v) => ({
          file: path.relative(OUT, path.join(dir, 'tiles', `f${f}_${v.label.replace(/\s/g, '')}.png`)),
          label: v.label,
        })),
      });
    }
  }
  await mkdir(OUT, { recursive: true });
  await writeSheetOnly(rows, VIEWS.length, `Antes × depois — ${path.basename(a)} / ${path.basename(b)}`);
  console.log(`folha em ${path.join(OUT, 'sheet.html')}`);
  process.exit(0);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// `count=0`: com `count=1` o laboratório já montou um avatar e a folha
// montaria o dela por cima — duas roupas no mesmo corpo, e o que se revisa é
// um defeito da ferramenta.
const url = `${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&matrix=1&count=0&spin=0&yaw=0`
  + `&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.34}&blink=${args.blink ?? 0}`;
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
await page.waitForTimeout(800);

await mkdir(path.join(OUT, 'tiles'), { recursive: true });
const rows = [];
for (const [fi, f] of FACES.entries()) {
  const cells = [];
  for (const v of VIEWS) {
    const png = await page.evaluate(
      ([cfg, expr, yaw, zoom]) => window.__lab.portrait(cfg, expr, yaw, zoom),
      [{
        facePreset: f, bodyPreset: f,
        skinTone: SKIN[fi % SKIN.length],
        // Pelo ÍNDICE na lista, não pelo número do preset: com `--faces=0,2` e
        // dois cabelos, `f % 2` dava o mesmo cabelo nas duas linhas e a folha
        // comparava um estilo com ele mesmo.
        hair: HAIR[fi % HAIR.length], hairColor: f,
      }, args.expression ?? 'neutral', v.yaw, Number(args.zoom ?? 1.06)],
    );
    const file = path.join('tiles', `f${f}_${v.label.replace(/\s/g, '')}.png`);
    await writeFile(path.join(OUT, file), Buffer.from(png.split(',')[1], 'base64'));
    cells.push({ file, label: v.label });
    process.stdout.write('·');
  }
  rows.push({ label: `rosto ${f}`, cells });
}
process.stdout.write('\n');

await writeSheet(rows, VIEWS.length, `Close do rosto — ${FACES.length} presets × frontal/3-4/perfil`);
await browser.close();
console.log(JSON.stringify({ tiles: rows.length * VIEWS.length, out: OUT, errors: errors.slice(0, 5) }, null, 2));

function sheetHtml(rows, cols, title) {
  return `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#0b0d12; color:#e8e6e1; font:11px ui-monospace,monospace; }
  h1 { font:600 15px system-ui,sans-serif; padding:14px 16px 8px; margin:0; }
  .row { display:grid; grid-template-columns:130px repeat(${cols}, 1fr); gap:6px; padding:0 12px 6px; align-items:center; }
  .row > b { font:600 11px system-ui,sans-serif; color:#9aa0ad; }
  figure { margin:0; background:#11141f; border:1px solid #232838; border-radius:8px; overflow:hidden; }
  img { display:block; width:100%; }
  figcaption { padding:4px; text-align:center; color:#6f7686; }
</style>
<h1>${title}</h1>
${rows.map((r) => `<div class="row"><b>${r.label}</b>${r.cells.map((c) =>
  `<figure><img src="${c.file}"><figcaption>${c.label}</figcaption></figure>`).join('')}</div>`).join('')}`;
}

async function writeSheet(rows, cols, title) {
  await writeFile(path.join(OUT, 'sheet.html'), sheetHtml(rows, cols, title));
  const sheet = await browser.newPage({ viewport: { width: 130 + cols * 420, height: 1200 } });
  await sheet.goto(`file://${path.resolve(path.join(OUT, 'sheet.html'))}`, { waitUntil: 'load' });
  await sheet.screenshot({ path: path.join(OUT, 'sheet.png'), fullPage: true });
  await sheet.close();
}

async function writeSheetOnly(rows, cols, title) {
  await writeFile(path.join(OUT, 'sheet.html'), sheetHtml(rows, cols, title));
  await readFile(path.join(OUT, 'sheet.html'));
}
