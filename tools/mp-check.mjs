/**
 * Ana renders in a real browser; Beto joins headless over colyseus.js and
 * walks. Two 3D pages under SwiftShader starve each other badly enough to blow
 * the seat reservation, and rendering Beto proves nothing extra: what matters
 * is that Ana's client draws a second avatar and follows its movement.
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';

const BASE = 'http://127.0.0.1:5273/?view=world&tier=high';
const API = 'http://127.0.0.1:8787';
const FIXED_DT = 1 / 24;

/**
 * O token vem da API, e não é mais o nome do usuário.
 *
 * Este arquivo mandava `token: 'beto'` — de quando o `?token=` era literalmente
 * o id e a API ainda não emitia sessão. Ela emite; o game server só confere
 * assinatura e desde então esta prova morria com `401 malformed_token` antes do
 * primeiro quadro. Uma prova que não roda não protege nada.
 */
async function login(username) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou (${res.status}) — a API está no ar?`);
  return (await res.json()).token;
}

const [tokenAna, tokenBeto] = await Promise.all([login('ana'), login('beto')]);

const beto = new Client('ws://127.0.0.1:2567');
const room = await beto.joinOrCreate('city', { token: tokenBeto, sceneId: 'central_plaza' });
console.log('beto entrou em', room.roomId);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${BASE}&token=${tokenAna}&name=Ana`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 })
  .catch(() => errors.push('sem __ready'));

const before = await page.evaluate(() => window.__lab.stats());

// Beto walks straight at the fountain: the server must stop him at its edge.
for (let seq = 1; seq <= 220; seq++) {
  room.send('move', { dx: -0.75, dz: -0.66, yaw: Math.atan2(-0.75, -0.66), run: true, seq });
  await new Promise((r) => setTimeout(r, FIXED_DT * 1000));
}
const betoPose = [...room.state.players.values()].find((p) => p.name === 'Beto')
  ?? [...room.state.players.values()][0];
console.log('beto parou em', {
  x: +betoPose.x.toFixed(2), z: +betoPose.z.toFixed(2),
  distanciaDoCentro: +Math.hypot(betoPose.x, betoPose.z).toFixed(2),
});
room.send('chat', { text: 'cheguei na praça!' });
await page.waitForTimeout(1500);

const after = await page.evaluate(() => window.__lab.stats());
console.log(JSON.stringify({ before, after, errors }, null, 2));

await page.screenshot({ path: 'shots/mp_ana.png', timeout: 60000 });
await room.leave();
await browser.close();
