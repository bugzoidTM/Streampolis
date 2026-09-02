#!/usr/bin/env node
/**
 * O tribunal do rosto do corpo que o jogo desenha.
 *
 * `face-sheet.mjs` e `face-close.mjs` fotografam o rosto PROCEDURAL — pálpebra,
 * sobrancelha e lábio articulados, e uma malha que o jogo não desenha desde a
 * migração. Este rosto é outro: um olho e uma sobrancelha em primitivos
 * separados dentro da malha da cabeça, e a pergunta que ele precisa responder
 * também é outra — **o olho fechado lê como olho fechado?**
 *
 * Uma coluna por estágio do piscar, com o reflexo PRESO em cada um. Preso
 * porque um piscar inteiro dura 220 ms: nenhuma captura o pega de propósito, e
 * uma que pegasse por sorte não serviria de comparação.
 *
 *   node tools/v2-face.mjs
 *   node tools/v2-face.mjs --chars=f_suit,m_worker --size=520
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const out = args.out ?? 'shots/v2-face';
const size = Number(args.size ?? 460);
const zoom = Number(args.zoom ?? 1);
const yaw = Number(args.yaw ?? 0.34);
/** Aberto, meio-fechado e fechado. O meio é onde um piscar ruim se denuncia. */
const BLINKS = (args.blinks ?? '0,0.5,1').split(',').map(Number);
const chars = (args.chars ?? 'm_casual_character,f_suit,m_business_man,f_punk')
  .split(',').filter(Boolean);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: size, height: size } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = `${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0`
  + `&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.55}`;
await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const char of chars) {
  const look = {
    hair: `${char}_head`, top: `${char}_top`,
    bottom: `${char}_bottom`, shoes: `${char}_shoes`,
  };
  for (const blink of BLINKS) {
    const res = await page.evaluate(([look, yaw, blink, zoom]) =>
      window.__lab.gameFace(look, yaw, blink, zoom), [look, yaw, blink, zoom]);
    if (!res) { console.error('sem __lab.gameFace — a bancada é antiga'); process.exit(2); }
    const file = path.join(out, `${char}_b${blink}.png`);
    await writeFile(file, Buffer.from(res.png.split(',')[1], 'base64'));
    // O que o rosto ACHOU na cabeça: um olho que não fecha e um olho que
    // ninguém achou dão a mesma imagem, e só este relatório os separa.
    if (blink === BLINKS[0]) console.log(char, JSON.stringify(res.face));
  }
}

/**
 * E a prova de que o reflexo ANDA: quantas vezes o olho fecha em 14 segundos, e
 * quanto ele chega a fechar. Sem isto, um rosto que só fecha quando alguém
 * prende o valor passaria por vivo.
 */
let falhas = 0;
for (const char of chars) {
  const look = {
    hair: `${char}_head`, top: `${char}_top`,
    bottom: `${char}_bottom`, shoes: `${char}_shoes`,
  };
  const trace = await page.evaluate(([l]) => window.__lab.blinkTrace(l, 14, 30), [look]);
  // Um traço todo em −1 é cabeça SEM OLHO, e isso não é defeito: o astronauta
  // usa capacete e o tático usa viseira. Melhor não piscar do que piscar uma
  // viseira.
  if (trace.every((v) => v < 0)) { console.log(`  – ${char} não tem olho (capacete ou viseira)`); continue; }
  const pico = Math.max(...trace);
  // Um piscar = uma travessia acima de 0,8. A 30 quadros por segundo, o fecho
  // (60 ms) cabe em dois quadros: contar cruzamentos, não quadros.
  let piscadas = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i] > 0.8 && trace[i - 1] <= 0.8) piscadas++;
  const ok = pico > 0.9 && piscadas >= 2;
  if (!ok) falhas++;
  console.log(`  ${ok ? '✓' : '✗'} ${char} pisca sozinho — ${piscadas} piscada(s) em 14 s, fecho máximo ${pico.toFixed(2)}`);
}

if (errors.length) console.error(errors.slice(0, 5).join('\n'));
await browser.close();
if (falhas) { console.error(`\n${falhas} rosto(s) sem reflexo`); process.exit(1); }
console.log('\n✅ todos os rostos piscam sozinhos');
