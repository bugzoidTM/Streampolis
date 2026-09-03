#!/usr/bin/env node
/**
 * Prova que a praça CONVERSA (PRD §6).
 *
 * Três coisas podem falhar separadamente e nenhuma aparece numa captura de
 * tela, por isso um teste e não um screenshot:
 *
 * 1. a fala de outra pessoa chega ao painel e vira BALÃO sobre a cabeça dela;
 * 2. a fala do próprio jogador vai ao servidor e VOLTA — o eco é do servidor,
 *    não local, porque é ele quem decide se a mensagem existe (SPECs §31);
 * 3. digitar não anda. `w`, `a`, `s` e `d` são teclas de movimento e o laço de
 *    entrada escuta a janela inteira: sem suspensão, escrever "vamos andar"
 *    manda o avatar embora no meio da frase.
 *
 * Ana num navegador de verdade, Beto headless por colyseus.js — duas páginas
 * 3D sob SwiftShader se matam de fome e a reserva de assento expira.
 *
 *   node tools/chat-check.mjs
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';
const API = args.api ?? 'http://127.0.0.1:8787';

/** Token de verdade: o game server confere a assinatura da API (SPECs §36). */
const login = async (username) => {
  const r = await fetch(`${API}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!r.ok) throw new Error(`dev-login ${username}: ${r.status}`);
  return (await r.json()).token;
};
const [tokenAna, tokenBeto] = [await login('ana'), await login('beto')];

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const beto = new Client(SERVER);
const room = await beto.joinOrCreate('city', { token: tokenBeto, sceneId: 'central_plaza' });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${CLIENT}/?scene=central_plaza&token=${tokenAna}&tier=high`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
await page.waitForTimeout(1200);

console.log('\n1) A fala de outra pessoa chega');
const DITO = 'oi, cheguei na praça';
room.send('chat', { text: DITO });
const chegou = await page
  .waitForFunction((t) => [...document.querySelectorAll('.wchat__text')].some((e) => e.textContent === t),
    DITO, { timeout: 30_000 })
  .then(() => true).catch(() => false);
check('a mensagem aparece no painel do mundo', chegou);

const comBalao = await page.evaluate(() => window.__lab.stats().bubbles);
check('a fala virou balão sobre a cabeça de quem falou', comBalao >= 1, `${comBalao} balão(ões)`);

// E a BOCA se mexe. Um balão sobre uma cara imóvel é o mesmo defeito do avatar
// que dançava parado: a informação chegou e o corpo não soube dela. Nada disto
// é protocolo — o texto e o id já vieram na mensagem que o servidor mandou a
// todo mundo, e cada navegador anima a partir deles.
const falou = await page.evaluate(async () => {
  const visto = [];
  for (let i = 0; i < 24; i++) {
    visto.push((window.__lab.stats().anim ?? []).some((a) => a.boca?.falando));
    await new Promise((r) => setTimeout(r, 90));
  }
  return { durante: visto.some(Boolean), quadros: visto.filter(Boolean).length };
});
check('a boca de quem falou se mexe', falou.durante, `${falou.quadros} amostras de boca aberta`);

// E PARA. Uma fala que não termina é um tique, não uma fala.
await page.waitForTimeout(5_000);
const calou = await page.evaluate(() => (window.__lab.stats().anim ?? []).every((a) => !a.boca?.falando));
check('e volta a ficar parada quando a fala acaba', calou);

console.log('\n2) Digitar não anda');
const antes = await page.evaluate(() => {
  const s = window.__lab.stats().local;
  return { x: s.x ?? s.solo?.x ?? 0, z: s.z ?? s.solo?.z ?? 0 };
});
await page.click('.wchat__input');
const suspenso = await page.evaluate(() => window.__lab.stats().typing);
check('o teclado do jogo é suspenso enquanto se digita', suspenso === true);

// A frase é escolhida a dedo: cada letra dela é uma tecla de movimento.
await page.keyboard.type('vamos andar', { delay: 45 });
await page.waitForTimeout(700);
const depois = await page.evaluate(() => {
  const s = window.__lab.stats().local;
  return { x: s.x ?? s.solo?.x ?? 0, z: s.z ?? s.solo?.z ?? 0 };
});
const andou = Math.hypot(depois.x - antes.x, depois.z - antes.z);
check('o avatar não saiu do lugar', andou < 0.05, `${andou.toFixed(3)} m`);

console.log('\n3) A própria fala volta do servidor');
await page.keyboard.press('Enter');
const voltou = await page
  .waitForFunction(() => [...document.querySelectorAll('.wchat__text')]
    .some((e) => e.textContent === 'vamos andar'), null, { timeout: 30_000 })
  .then(() => true).catch(() => false);
check('a mensagem do jogador local volta pelo servidor', voltou);

const recebida = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 8_000);
  room.onMessage('chatMessage', (m) => {
    if (m.text === 'vamos andar') { clearTimeout(timer); resolve(true); }
  });
  // A que já chegou antes deste ouvinte não conta; se o servidor for rápido
  // demais, a de baixo garante uma segunda passagem.
  setTimeout(() => room.send('chat', { text: 'vamos andar' }), 500);
});
check('a outra pessoa na sala recebe a fala', recebida);

console.log('\n4) Escape solta o teclado');
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const soltou = await page.evaluate(() => window.__lab.stats().typing);
check('o jogo volta a ouvir o teclado', soltou === false);

await page.screenshot({ path: 'shots/chat.png', timeout: 120_000 });
await room.leave();
await browser.close();

const ok = results.filter(Boolean).length;
if (errors.length) console.log('\nerros no console:', errors.slice(0, 5));
console.log(`\n${ok === results.length ? '✅' : '❌'} ${ok}/${results.length} verificações passaram. Captura em shots/chat.png`);
process.exit(ok === results.length ? 0 : 1);
