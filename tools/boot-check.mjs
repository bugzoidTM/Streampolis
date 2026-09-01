#!/usr/bin/env node
/**
 * Prova que a PRIMEIRA tela existe — e que ela sai.
 *
 * A tela de carregamento do jogo é React: ela só aparece depois de o bundle
 * baixar, e o bundle tem three.js dentro. A tela de arranque do `index.html`
 * cobre exatamente essa janela, e por isso é invisível em desenvolvimento —
 * com o bundle em cache ela dura milissegundos e ninguém a revisa. Aqui a
 * rede é estrangulada de propósito, que é a condição em que ela existe.
 *
 * Falha (código 1) se a tela não pintar, se o texto vier vazio, ou se ela
 * NÃO for embora — uma tela de arranque que fica é pior do que nenhuma.
 *
 *   node tools/boot-check.mjs [--client=http://127.0.0.1:5273] [--kbps=220]
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const CLIENT = args.client ?? 'http://127.0.0.1:5273';
// 1,2 Mbps. Em DESENVOLVIMENTO o Vite serve centenas de módulos soltos, e
// estrangular a 200 kbps aqui não simula uma rede ruim — simula uma rede
// impossível, com a página levando minutos por um motivo que não existe em
// produção, onde tudo isso vira um punhado de arquivos.
const KBPS = Number(args.kbps ?? 1200);
const OUT = args.out ?? 'shots/boot-splash.png';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false, latency: 120,
  downloadThroughput: KBPS * 1024, uploadThroughput: KBPS * 1024,
});

// `commit` e não `load`: o ponto do teste é o que existe ANTES de o script
// rodar. Esperar a página carregar é esperar justamente o que ela cobre.
await page.goto(`${CLIENT}/?scene=central_plaza`, { waitUntil: 'commit' });
await mkdir(OUT.replace(/\/[^/]+$/, ''), { recursive: true });
await writeFile(OUT, await page.screenshot());

const early = await page.evaluate(() => {
  const el = document.getElementById('boot');
  return { present: !!el, text: (el?.innerText ?? '').replace(/\s+/g, ' ').trim() };
});

let left = true;
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 120_000 })
  .catch(() => { left = false; });

await browser.close();
const ok = early.present && early.text.length > 0 && left;
console.log(JSON.stringify({ pintou: early.present, texto: early.text, saiu: left, shot: OUT }, null, 2));
process.exit(ok ? 0 : 1);
