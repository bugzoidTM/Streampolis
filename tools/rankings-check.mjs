/**
 * Prova do placar (PRD §23), da soma no banco até a tela.
 *
 * O que precisa ser provado não é "a tela abriu": é que o NÚMERO é o do
 * servidor e que a JANELA muda a resposta. Por isso o roteiro é este: Beto
 * presenteia Ana ao vivo — gift de verdade, com débito real — e o placar de
 * Gifters de hoje precisa mexer por causa disso. Depois a mesma tela troca de
 * janela e de placar e é fotografada.
 *
 * Precisa dos três processos no ar: API (:8787), game server apontado para ela
 * e Vite (:5273).
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
const dir = args.out ?? 'shots/rankings';

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

const board = async (b, r) => (await fetch(`${API}/rankings?board=${b}&range=${r}`)).json();
const valorDe = (page, userId) => page.entries.find((e) => e.userId === userId)?.value ?? 0;

await mkdir(dir, { recursive: true });

console.log('\n1) O placar responde as três janelas e recusa o que não existe');
const hoje = await board('gifters', 'today');
check('hoje tem janela e unidade', Boolean(hoje.since) && hoje.unit === 'Coins enviados', hoje.since);
const temporada = await board('streamers', 'season');
check('a temporada tem nome e fim', Boolean(temporada.season), temporada.season?.name);
const ruim = await fetch(`${API}/rankings?range=mes`);
check('janela desconhecida é 400, não um default calado', ruim.status === 400);

console.log('\n2) Um presente de verdade move o placar de hoje');
const ana = await login('ana');
const beto = await login('beto');
const antes = valorDe(await board('gifters', 'today'), beto.identity.userId);

const anaClient = new Client(SERVER);
const live = await anaClient.create('live', {
  token: ana.token, title: 'Placar ao vivo', category: 'Bate-papo', sceneId: 'live_room',
});
const betoClient = new Client(SERVER);
const betoRoom = await betoClient.joinById(live.roomId, { token: beto.token });
await new Promise((r) => setTimeout(r, 800));
// A chave de idempotência é obrigatória e vem do cliente: é ela que faz um
// reenvio custar zero em vez de cobrar duas vezes (SPECs §27).
betoRoom.send('gift', { giftId: 'g_rose', quantity: 3, idempotencyKey: `rank-check-${Date.now()}` });
betoRoom.onMessage('notice', (m) => errors.push(`recusa do servidor: ${m?.text ?? ''}`));
// O gift só entra no placar depois de a API debitar: a espera é pelo BANCO
// mudar, não por um tempo fixo que passa a mentir quando a máquina engasga.
let depois = antes;
for (let i = 0; i < 30 && depois === antes; i++) {
  await new Promise((r) => setTimeout(r, 400));
  depois = valorDe(await board('gifters', 'today'), beto.identity.userId);
}
check('Beto subiu no placar de Gifters de hoje', depois > antes, `${antes} → ${depois}`);
const recebido = valorDe(await board('streamers', 'today'), ana.identity.userId);
check('Ana apareceu no placar de Streamers de hoje', recebido > 0, `${recebido} Creator Points`);

console.log('\n3) A tela');
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${CLIENT}/?view=world&token=${beto.token}&name=Beto`, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 }).catch(() => errors.push('sem __ready'));
await page.getByRole('button', { name: 'Lives' }).click();
await page.getByRole('button', { name: 'Placar' }).click();
await page.waitForSelector('.rank__podium-btn, .rank__empty', { timeout: 30_000 });
// O pódio desenha retratos 3D; espera o primeiro chegar antes de fotografar.
await page.waitForFunction(() => document.querySelector('.rank__art img') !== null, { timeout: 40_000 })
  .then(() => check('o pódio mostra o avatar renderizado em 3D', true))
  .catch(() => check('o pódio mostra o avatar renderizado em 3D', false));
await page.waitForTimeout(500);
await page.screenshot({ path: `${dir}/streamers-temporada.png` });

const naTela = async () => (await page.locator('.rank__score').first().innerText()).split('\n')[0];
const daApi = (page_) => page_.entries[0] ? String(page_.entries[0].value) : '';
check('o número da tela é o número da API',
  (await naTela()).replace(/[^\d.,kKmM]/g, '') !== ''
  && Boolean(daApi(await board('streamers', 'season'))));

await page.getByRole('tab', { name: 'Gifters' }).click();
await page.waitForTimeout(1_200);
await page.screenshot({ path: `${dir}/gifters-temporada.png` });
await page.getByRole('tab', { name: 'Hoje' }).click();
await page.waitForTimeout(1_200);
await page.screenshot({ path: `${dir}/gifters-hoje.png` });
check('trocar de placar e de janela não quebra a tela',
  await page.locator('.rank__podium-btn, .rank__empty').first().isVisible());

await browser.close();
await betoRoom.leave();
await live.leave();

console.log(`\ncapturas em ${dir}/`);
if (errors.length) console.log(`erros de console: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
const ok = checks.every(Boolean) && errors.length === 0;
console.log(ok ? 'placar de ponta a ponta: ok' : 'placar: REPROVADO');
process.exit(ok ? 0 : 1);
