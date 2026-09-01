#!/usr/bin/env node
/**
 * Fotografa a tela de carregamento a caminho da cena.
 *
 * Ela existe por poucos segundos e é a primeira coisa que o jogador vê, então
 * é exatamente o tipo de tela que ninguém revisa e todo mundo julga. Captura
 * em vários instantes porque o que interessa é como ela ENCHE, não um quadro.
 *
 *   node tools/loading-shot.mjs [--at=400,1200,2500,5000] [--query=scene=central_plaza]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const OUT = args.out ?? 'shots/loading';
const QUERY = args.query ?? 'scene=central_plaza';
const AT = (args.at ?? '500,1500,3500,7000').split(',').map(Number);

const res = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ana' }),
});
const { token } = await res.json();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 619 } });
await mkdir(OUT, { recursive: true });

const started = Date.now();
await page.goto(`${CLIENT}/?${QUERY}&token=${token}&tier=${args.tier ?? 'high'}`, { waitUntil: 'commit' });

let last = 0;
for (const ms of AT) {
  await page.waitForTimeout(Math.max(0, ms - last));
  last = ms;
  const file = path.join(OUT, `t${ms}.png`);
  await writeFile(file, await page.screenshot({ type: 'png', timeout: 120_000 }));
  const state = await page.evaluate(() => {
    const bar = document.querySelector('[role="progressbar"]');
    return {
      pct: bar?.getAttribute('aria-valuenow') ?? null,
      label: document.querySelector('.loading__label')?.textContent ?? null,
      gone: !document.querySelector('.loading'),
    };
  }).catch(() => null);
  console.log(`${ms} ms  ${JSON.stringify(state)}  → ${file}`);
}

await page.waitForFunction(() => window.__ready === true, { timeout: 120_000 }).catch(() => {});
console.log(`pronto em ${Date.now() - started} ms`);
await browser.close();
