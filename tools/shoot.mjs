#!/usr/bin/env node
/**
 * Headless capture for the visual review loop. Boots the client, waits for the
 * render pipeline to warm up (post-processing shaders compile on first frame),
 * then writes a PNG plus a renderer.info sample next to it.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || 'true'];
  }),
);

const url = args.url ?? 'http://127.0.0.1:5273/';
const out = args.out ?? 'shots/shot.png';
const width = Number(args.w ?? 1600);
const height = Number(args.h ?? 900);
const settle = Number(args.settle ?? 2500);

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
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: Number(args.dpr ?? 1),
});

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
try {
  await page.waitForFunction(() => window.__ready === true, { timeout: 45_000 });
} catch {
  errors.push('timeout waiting for __ready');
}
await page.waitForTimeout(settle);

const stats = await page.evaluate(() => window.__lab?.stats?.() ?? null);

await mkdir(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, timeout: 180_000, animations: 'disabled' });
await writeFile(out.replace(/\.png$/, '.json'), JSON.stringify({ url, stats, errors }, null, 2));

console.log(JSON.stringify({ out, stats, errors }, null, 2));
await browser.close();
