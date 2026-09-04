/**
 * Prova do "Encontrar" pela INTERFACE, com API e game server de verdade.
 *
 * O e2e de sockets (`e2e:meet`) prova o mecanismo; este prova o caminho que o
 * jogador percorre: dois navegadores, duas contas criadas pelo cadastro novo,
 * uma amizade aceita, e o botão da lista levando um até a sala do outro. O que
 * se confere no fim é a única coisa observável que separa "encontrei" de
 * "entrei numa praça igual": os dois no MESMO roomId, segundo a presença que o
 * game server publicou.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.argv[2] ?? '/root/streampolis/shots/social';
const CLIENT = 'http://127.0.0.1:5273/';
const API = 'http://127.0.0.1:8787';
await mkdir(OUT, { recursive: true });

const stamp = Date.now().toString(36).slice(-5);
const call = async (path, body, token) => {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.json();
};

const criar = (nome) => call('/auth/register', {
  username: `${nome}_${stamp}`, email: `${nome}_${stamp}@t.local`, password: 'praca-central-9',
});

const ana = await criar('ana');
const bia = await criar('bia');
console.log('ana', ana.identity.userId, '| bia', bia.identity.userId);

// Amizade aceita: o portão do endereço é ela, e é a API que o guarda.
await call(`/friends/${bia.identity.userId}`, {}, ana.token);
await call(`/friends/${ana.identity.userId}/accept`, {}, bia.token);

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'];

// Um navegador por jogador: dois contextos WebGL no mesmo processo, sob
// swiftshader, disputam a mesma CPU e o screenshot passa do tempo.
const navegadores = [];
const erros = [];
async function abrir(sessao) {
  const browser = await chromium.launch({ args: ARGS });
  navegadores.push(browser);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  // O par inteiro no armazenamento: com só o access, a sessão morre em 15 min.
  await page.addInitScript((s) => {
    localStorage.setItem('streampolis.token', s.token);
    localStorage.setItem('streampolis.refresh', s.refreshToken);
    localStorage.setItem('streampolis.expires', String(Date.now() + s.expiresIn * 1000));
  }, sessao);
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(11000);
  return page;
}

const pAna = await abrir(ana);
const pBia = await abrir(bia);

// A presença leva um batimento para chegar à API.
await pAna.waitForTimeout(2500);
const ondeAna = await call(`/friends/${ana.identity.userId}/location`, undefined, bia.token);
console.log('onde ana está, para bia:', ondeAna);

const passosAna = await call('/me/onboarding', undefined, ana.token);
console.log('onboarding de ana:', passosAna.steps.map((s) => `${s.step}=${s.done}`).join(' '));

// Bia vai até Ana pela interface.
await pBia.getByRole('button', { name: 'Perfil' }).click();
await pBia.waitForTimeout(3000);
await pBia.getByRole('button', { name: /^Amigos/ }).click();
await pBia.waitForTimeout(2500);
await pBia.screenshot({ path: `${OUT}/09-amigo-online.png`, timeout: 60000 });

const encontrar = pBia.getByRole('button', { name: 'Encontrar' }).first();
console.log('botão Encontrar visível:', (await encontrar.count()) > 0);
if (await encontrar.count()) {
  await encontrar.click();
  await pBia.waitForTimeout(9000);
  await pBia.screenshot({ path: `${OUT}/10-encontro.png`, timeout: 60000 });
}

await pBia.waitForTimeout(2000);
const depoisAna = await call(`/friends/${ana.identity.userId}/location`, undefined, bia.token);
const depoisBia = await call(`/friends/${bia.identity.userId}/location`, undefined, ana.token);
const mesma = depoisAna.presence?.roomId && depoisAna.presence.roomId === depoisBia.presence?.roomId;
console.log('sala de ana:', depoisAna.presence?.roomId, '| sala de bia:', depoisBia.presence?.roomId);
console.log(mesma ? '✅ as duas estão na MESMA sala' : '❌ salas diferentes');

console.log('erros de console:', erros.length ? erros : 'nenhum');
for (const b of navegadores) await b.close();
process.exit(mesma ? 0 : 1);
