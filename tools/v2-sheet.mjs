#!/usr/bin/env node
/**
 * A folha de contato do corpo QUE O JOGO DESENHA.
 *
 * `figure-sheet.mjs`, `face-sheet.mjs`, `face-close.mjs`, `hand-shot.mjs` e a
 * matriz de 176 combinações medem `new Avatar(...)` — o corpo PROCEDURAL, que
 * desde a migração v2 só aparece com `?body=v1` na URL. Nenhum instrumento
 * deste repositório apontava para o corpo real, e foi por isso que 21 camisas
 * sem braço e 17 tênis sem sola chegaram à praça sem ninguém ver.
 *
 * Esta aponta. Uma linha por personagem, três giros por linha, mais o
 * INVENTÁRIO DE MALHAS de cada um — porque quando uma peça some, a primeira
 * pergunta é "ela entrou na cena?", e um PNG não responde isso.
 *
 *   node tools/v2-sheet.mjs
 *   node tools/v2-sheet.mjs --chars=m_casual_character,f_suit --yaws=0,1.6,3.14
 *   node tools/v2-sheet.mjs --anim=walk --out=shots/v2-andando
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const out = args.out ?? 'shots/v2';
const w = Number(args.w ?? 460);
const h = Number(args.h ?? 700);
const yaws = (args.yaws ?? '0,0.9,3.14').split(',').map(Number);
const anim = args.anim ?? 'idle';
const zoom = Number(args.zoom ?? 1);

/**
 * Quem posa. São personagens INTEIROS por padrão: a mistura de peças é o
 * assunto de outra prova (a de guarda-roupa), e um defeito de montagem aparece
 * mais depressa no conjunto que o autor do pacote desenhou.
 */
const chars = (args.chars ?? 'm_casual_character,f_suit,m_business_man,f_punk,m_worker')
  .split(',').filter(Boolean);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

// `count=0`: sem isto a bancada já monta os cinco avatares dela e a folha
// fotografa o nosso por cima dos deles.
const url = `${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0`
  + `&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.55}`;
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const report = [];
for (const char of chars) {
  const look = {
    hair: `${char}_head`, top: `${char}_top`,
    bottom: `${char}_bottom`, shoes: `${char}_shoes`,
  };
  for (const yaw of yaws) {
    const res = await page.evaluate(([look, yaw, anim, zoom]) =>
      window.__lab.gameFigure(look, yaw, anim, zoom), [look, yaw, anim, zoom]);
    if (!res) { console.error('sem __lab.gameFigure — a bancada é antiga'); process.exit(2); }
    const file = path.join(out, `${char}_y${yaw}.png`);
    await writeFile(file, Buffer.from(res.png.split(',')[1], 'base64'));
    if (yaw === yaws[0]) {
      report.push({ char, eyeHeight: res.eyeHeight, meshes: res.meshes });
      const tris = res.meshes.reduce((a, m) => a + m.tris, 0);
      console.log(`${char}: ${res.meshes.length} malhas, ${tris} triângulos, olhos a ${res.eyeHeight} m`);
      for (const m of res.meshes) console.log(`   ${m.material.padEnd(20)} ${m.tris}`);
    }
  }
}

await writeFile(path.join(out, 'report.json'), JSON.stringify({ chars, anim, report, errors }, null, 2));
console.log(`\n${out}/`);
if (errors.length) console.error(errors.slice(0, 5).join('\n'));
await browser.close();
