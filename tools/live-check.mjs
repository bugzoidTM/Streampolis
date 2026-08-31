/**
 * Prova de ponta a ponta da LIVE, com navegador de verdade.
 *
 * Ana abre a própria live no cliente (`?golive=1`), Beto entra headless pela
 * sala que ela criou, manda uma mensagem e um presente. O que se verifica é o
 * elo inteiro: a intenção vira LiveRoom, a LiveRoom vira LiveRoomScene, o
 * GiftEvent vira efeito no Three.js e linha no chat.
 *
 * Beto não renderiza de propósito: duas páginas 3D no SwiftShader se matam de
 * fome e estouram a reserva de assento (a mesma razão do tools/mp-check.mjs).
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';
const API = args.api ?? 'http://127.0.0.1:8787';
const out = args.out ?? 'shots/live.png';
const gift = args.gift ?? 'g_star';

/**
 * Token de quem entra. Com a API no ar (e o game server apontado para ela) é um
 * JWT de verdade; sem ela, o game server aceita o próprio username como token
 * de desenvolvimento. Fixar um dos dois quebra o script metade das vezes.
 */
async function tokenFor(username) {
  try {
    const res = await fetch(`${API}/auth/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    if (res.ok) return (await res.json()).token;
  } catch {
    // API fora: segue no modo de desenvolvimento do game server.
  }
  return username;
}

const errors = [];
const checks = [];
const check = (label, ok, detail) => {
  checks.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\n1) Ana abre a própria live');
const anaToken = await tokenFor('ana');
await page.goto(
  `${CLIENT}/?view=world&token=${anaToken}&name=Ana&golive=1&title=Primeira%20live&category=musica`,
  { waitUntil: 'networkidle', timeout: 60_000 },
);
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 })
  .catch(() => errors.push('sem __ready'));
await page.waitForTimeout(1_200);

const stats = await page.evaluate(() => window.__lab.stats());
check('a cena é a Live Room', stats.scene === 'live_room', stats.scene);
check('o cliente está online', stats.online === true);

const room = await page.evaluate(() => {
  const state = window.__world.connection?.state;
  return state ? { id: window.__world.connection.room.roomId, hostId: state.hostId, live: state.liveId } : null;
});
check('a sala é uma LiveRoom com host', Boolean(room?.hostId), room?.hostId);

console.log('\n2) Beto entra como espectador');
const betoClient = new Client(SERVER);
const beto = await betoClient.joinById(room.id, { token: await tokenFor('beto') });
await new Promise((r) => setTimeout(r, 800));

const viewers = await page.evaluate(() => window.__world.connection.state.viewers);
check('a live conta o espectador', viewers >= 1, `viewers=${viewers}`);

console.log('\n3) Beto fala e presenteia');
beto.send('chat', { text: 'oi ana!' });
beto.send('like', { count: 3 });
beto.send('gift', {
  giftId: gift, quantity: 1, idempotencyKey: `live-check-${Date.now()}`,
});

// O efeito nasce quando o GiftEvent chega, que é depois da cobrança.
await page.waitForFunction(() => window.__lab.stats().particles > 0, { timeout: 15_000 })
  .then(() => check('o presente virou partículas na cena', true))
  .catch(() => check('o presente virou partículas na cena', false, 'nenhuma partícula em 15s'));

const chat = await page.evaluate(() => window.__world.stats() && document.querySelectorAll('.live__msg').length);
check('o chat da live mostra as linhas', chat > 0, `${chat} mensagens`);

const ui = await page.evaluate(() => ({
  live: Boolean(document.querySelector('.live')),
  tray: Boolean(document.querySelector('.live__actions')),
}));
check('a LiveView está montada', ui.live && ui.tray);

await mkdir(path.dirname(out), { recursive: true });
await page.screenshot({ path: out, timeout: 120_000 });
console.log(`\nCaptura: ${out}`);
if (errors.length) console.log('Erros de console:', errors);

const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0
  ? `\n✅ ${checks.length}/${checks.length} verificações passaram.`
  : `\n❌ ${failed} de ${checks.length} falharam.`);

await beto.leave();
await browser.close();
process.exit(failed === 0 ? 0 : 1);
