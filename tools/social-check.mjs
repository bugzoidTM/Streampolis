/**
 * Prova do mundo COMO LUGAR COM GENTE: quem está aqui, e o que a gente faz.
 *
 * O multiplayer já sincronizava corpos — `mp-check.mjs` prova que um segundo
 * avatar aparece e que o servidor barra quem atravessa a fonte. O que faltava
 * era tudo o que se faz DEPOIS de estar junto:
 *
 * - **Saber quem está.** A única forma era virar a câmera e ler as placas ao
 *   alcance, o que falha para o resto de uma praça de 26 m de raio.
 * - **Gesticular.** O servidor aceitava seis gestos, com recarga e recusa para
 *   quem anda, desde sempre — e nenhum caminho da mão do jogador até
 *   `connection.emote()`. Um mundo social com exatamente uma forma de se
 *   expressar: texto.
 *
 * O roteiro tem duas direções de propósito. Ana gesticula e a prova é lida no
 * estado que o BETO recebe (saiu daqui e atravessou a rede); Beto gesticula e a
 * prova é lida no corpo que a ANA desenha (chegou lá e virou movimento). Um
 * gesto que só o próprio jogador vê é o defeito clássico desta feature.
 *
 * Precisa da API (:8787), do game server apontado para ela e do Vite (:5273).
 *
 *   node tools/social-check.mjs
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';
import { mkdir } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';
const dir = args.out ?? 'shots/social';

const checks = [];
const errors = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

async function login(username) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou (${res.status})`);
  return res.json();
}

/**
 * Espera uma condição em vez de dormir um tempo fixo.
 *
 * O `await` no resultado de `fn` é o que faz isto valer para uma leitura do
 * navegador, que é assíncrona: sem ele, uma promessa pendente conta como
 * "verdadeiro" na primeira volta e a espera vira nenhuma espera.
 */
async function until(fn, ms = 8_000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

await mkdir(dir, { recursive: true });

const ana = await login('ana');
const beto = await login('beto');

console.log('\n1) Dois jogadores na mesma praça');
const betoClient = new Client(SERVER);
const sala = await betoClient.joinOrCreate('city', { token: beto.token, sceneId: 'central_plaza' });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${CLIENT}/?view=world&scene=central_plaza&token=${ana.token}&name=Ana`,
  { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
await page.waitForTimeout(1_500);

const stats = () => page.evaluate(() => window.__lab.stats());
check('a sala tem os dois corpos', (await stats()).actors === 2, `${(await stats()).actors} atores`);

console.log('\n2) Quem está aqui');
const linhas = page.locator('.roster__row');
await page.waitForSelector('.roster__row', { timeout: 20_000 }).catch(() => {});
check('o painel lista as duas pessoas', (await linhas.count()) === 2,
  `${await linhas.count()} linhas`);
const nomes = await linhas.allInnerTexts();
check('e Beto está entre elas', nomes.some((t) => t.includes('Beto')),
  nomes.map((t) => t.split('\n')[0]).join(', '));

console.log('\n3) O gesto da Ana atravessa a rede');
const anaNaSala = () => [...sala.state.players.values()].find((p) => p.name === 'Ana');
check('Beto vê a Ana parada antes', anaNaSala()?.anim === 'idle', anaNaSala()?.anim);
// Tecla 4 = Dançar. É o atalho do teclado, que é como um jogo de computador
// gesticula — e ele passa pelo mesmo caminho do botão.
await page.keyboard.press('4');
const dancando = await until(() => anaNaSala()?.anim === 'dance');
check('o "4" da Ana chega ao Beto como dance', Boolean(dancando), anaNaSala()?.anim);

console.log('\n4) O gesto do Beto vira movimento na tela da Ana');
sala.send('emote', { anim: 'wave' });
const acenou = await until(async () => (await stats()).anim.some((a) => a.state === 'wave'), 10_000);
check('a Ana desenha o aceno do Beto', Boolean(acenou),
  (await stats()).anim.map((a) => a.state).join(', '));
await page.screenshot({ path: `${dir}/praca.png` });

console.log('\n5) Andar cancela o gesto (regra do servidor)');
await page.keyboard.down('w');
await page.waitForTimeout(1_200);
await page.keyboard.up('w');
const andou = await until(() => anaNaSala()?.anim === 'walk' || anaNaSala()?.anim === 'idle');
check('a Ana deixou de dançar ao andar', Boolean(andou), anaNaSala()?.anim);

console.log('\n6) Da lista para o perfil');
const linhaBeto = page.locator('.roster__row', { hasText: 'Beto' }).first();
await linhaBeto.click();
const abriu = await page.waitForSelector('.screen', { timeout: 20_000 }).then(() => true).catch(() => false);
check('clicar em alguém abre o perfil dele', abriu);
if (abriu) {
  // O perfil chega da API depois da tela: esperar o TEXTO, e não a tela, é a
  // diferença entre provar "abriu o perfil do Beto" e "abriu 'Carregando…'".
  const texto = await until(async () => {
    const t = await page.locator('.screen').first().innerText();
    return t.includes('Beto') ? t : null;
  }, 20_000);
  check('e é o perfil do Beto', Boolean(texto), (texto ?? '').split('\n')[0] || 'não carregou');
}
await page.screenshot({ path: `${dir}/perfil.png` });

await browser.close();
await sala.leave();

console.log(`\ncapturas em ${dir}/`);
if (errors.length) console.log(`erros de console: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
const ok = checks.every(Boolean);
console.log(`${ok ? '✅' : '❌'} ${checks.filter(Boolean).length}/${checks.length} verificações passaram.`);
process.exit(ok ? 0 : 1);
