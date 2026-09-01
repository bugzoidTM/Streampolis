#!/usr/bin/env node
/**
 * HOJE × ASSET PASS: a mesma cena, o mesmo layout e a mesma colisão,
 * capturados duas vezes — `?assets=0` procedural e `?assets=1` com os modelos
 * que passaram pelo passe.
 *
 * A comparação existe para ser decidida por uma imagem e não por memória. Uma
 * captura de antes e outra de depois, no MESMO enquadramento, é a única forma
 * de responder se o pipeline de assets vale a manutenção que cobra.
 *
 *   node tools/scene-ab.mjs [--query=scene=central_plaza] [--out=shots/ab]
 *                           [--walk=2600] [--look=yaw,pitch,dist] [--tier=high]
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
const OUT = args.out ?? 'shots/ab';
const TIER = args.tier ?? 'high';
const W = Number(args.w ?? 1100);
const H = Number(args.h ?? 619);
const SETTLE = Number(args.settle ?? 13000);
const QUERY = args.query ?? 'scene=central_plaza';

const res = await fetch(`${API}/auth/dev-login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ana' }),
});
if (!res.ok) throw new Error(`dev-login falhou: ${res.status}`);
const { token } = await res.json();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});

await mkdir(OUT, { recursive: true });
const report = [];

for (const [name, assets] of [['hoje', '0'], ['pass', '1']]) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  const url = `${CLIENT}/?${QUERY}&token=${token}&tier=${TIER}&assets=${assets}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });
  try {
    await page.waitForFunction(() => window.__ready === true, { timeout: 120_000 });
  } catch { errors.push('timeout esperando __ready'); }
  await page.waitForTimeout(SETTLE);

  // Andar antes de fotografar tira a câmera do anel de bancos, que é onde o
  // avatar nasce: o braço da câmera colide com o encosto e a foto sai de
  // dentro de um banco.
  if (args.walk) {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(Number(args.walk));
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(2500);
  }

  if (args.framing) {
    await page.evaluate((f) => window.__world?.camera?.setFraming(f, true), args.framing);
    await page.waitForTimeout(2500);
  }

  // Afastar pela RODA, não escrevendo `distance`: o braço da câmera tem
  // colisão, e num quarto de 8×7 m escrever a distância à mão põe a câmera do
  // lado de fora da parede. A roda respeita o limite; escrever, não.
  if (args.zoom) {
    for (let i = 0; i < Number(args.zoom); i++) {
      await page.mouse.move(W / 2, H / 2);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(1800);
  }

  // Uma segunda vista, olhando para o anel de prédios: o enquadramento padrão
  // é o do jogador, e o horizonte é justamente o que a experiência mudou.
  if (args.look) {
    const [yaw, pitch, dist] = args.look.split(',').map(Number);
    await page.evaluate(([y, p, d]) => {
      const cam = window.__world?.camera;
      if (!cam) return;
      cam.yaw = y; cam.pitch = p; cam.distance = d;
    }, [yaw, pitch, dist]);
    await page.waitForTimeout(2500);
  }

  const stats = await page.evaluate(() => window.__world?.stats?.() ?? null).catch(() => null);
  const file = path.join(OUT, `${name}.png`);
  await writeFile(file, await page.screenshot({ type: 'png', timeout: 240_000, animations: 'disabled' }));
  report.push({ name, assets, file, stats, errors: errors.slice(0, 4) });
  console.log(`${file}${stats ? `  ${JSON.stringify(stats)}` : ''}`);
  if (errors.length) console.error(`  ! ${errors[0]}`);
  await page.close();
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
await browser.close();
