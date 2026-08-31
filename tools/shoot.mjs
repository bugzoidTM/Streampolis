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
/** Forces every avatar into one animation state before the shot. */
const anim = args.anim ?? null;
/**
 * `canvas` grabs the frame through the renderer's own capture path (render +
 * toDataURL in one task), which is what proves the context still produces a
 * readable frame WITHOUT preserveDrawingBuffer. `page` uses the compositor.
 */
const mode = args.mode ?? 'page';

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

if (anim) {
  await page.evaluate((state) => window.__lab?.anim?.(state === 'none' ? null : state), anim);
  await page.waitForTimeout(Number(args.hold ?? 900));
}

const stats = await page.evaluate(() => window.__lab?.stats?.() ?? null);
const clips = await page.evaluate(() => window.__lab?.animReport?.() ?? null);

await mkdir(path.dirname(out), { recursive: true });
if (mode === 'canvas') {
  const data = await page.evaluate(() => window.__lab?.capture?.() ?? null);
  if (!data) throw new Error('captura pelo canvas indisponível');
  await writeFile(out, Buffer.from(data.split(',')[1], 'base64'));
} else {
  await page.screenshot({ path: out, timeout: 180_000, animations: 'disabled' });
}
await writeFile(out.replace(/\.png$/, '.json'), JSON.stringify({ url, anim, stats, clips, errors }, null, 2));

console.log(JSON.stringify({ out, stats, clips, errors }, null, 2));
await browser.close();
