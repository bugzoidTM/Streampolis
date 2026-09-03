/**
 * Prova do jogo no COMPUTADOR: a câmera obedece ao mouse, e entrar num cômodo
 * é entrar nele.
 *
 * Três coisas que um build limpo não prova e que só aparecem com o ponteiro na
 * mão:
 *
 * - **Girar.** A órbita existia só no botão DIREITO — um atalho que ninguém
 *   descobre —, e a impressão era a de que o avatar só andava em quatro
 *   direções.
 * - **Aproximar.** A roda chegava à câmera multiplicada por 0,01: quatro
 *   milímetros por clique num braço de 1,4 m a 9 m. O zoom respondia e não
 *   movia nada que o olho pudesse notar.
 * - **Entrar.** O ponto de chegada de cada interior caía DENTRO do raio da
 *   porta de saída. Quem entrava no próprio apartamento aparecia com "Sair" na
 *   tela; no saguão, cuja saída dá na praça, quem subia para buscar a própria
 *   casa reaparecia na praça.
 *
 * Precisa da API (:8787), do game server apontado para ela e do Vite (:5273).
 *
 *   node tools/desktop-check.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const dir = args.out ?? 'shots/desktop';

const checks = [];
const errors = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const res = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: args.user ?? 'ana' }),
});
if (!res.ok) throw new Error(`login falhou (${res.status})`);
const { token } = await res.json();

await mkdir(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
page.on('pageerror', (e) => errors.push(String(e.message)));

const cam = () => page.evaluate(() => ({
  yaw: window.__world.camera.yaw,
  pitch: window.__world.camera.pitch,
  dist: window.__world.camera.distance,
}));
const stats = () => page.evaluate(() => window.__lab.stats());

async function enter(query, rotulo) {
  await page.goto(`${CLIENT}/?view=world&token=${token}&name=Ana&${query}`,
    { waitUntil: 'networkidle', timeout: 90_000 });
  // A praça com assets no rasterizador de software leva minutos para o
  // primeiro quadro; este é o mesmo teto que as outras provas usam.
  await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
  await page.waitForTimeout(1_200);
  console.log(`\n${rotulo}`);
}

const arrasta = async (botao, passos = 9) => {
  await page.mouse.move(500, 380);
  await page.mouse.down({ button: botao });
  for (let i = 1; i <= passos; i++) await page.mouse.move(500 + i * 20, 380);
  await page.mouse.up({ button: botao });
  await page.waitForTimeout(250);
};

const roda = async (voltas, sentido) => {
  await page.mouse.move(500, 380);
  for (let i = 0; i < voltas; i++) { await page.mouse.wheel(0, 120 * sentido); await page.waitForTimeout(70); }
  await page.waitForTimeout(300);
};

await enter('scene=central_plaza', '1) A câmera obedece ao mouse (praça)');
const inicio = await cam();

await arrasta('left');
const esquerdo = await cam();
check('arrastar com o botão esquerdo gira a câmera', Math.abs(esquerdo.yaw - inicio.yaw) > 0.5,
  `${inicio.yaw.toFixed(2)} → ${esquerdo.yaw.toFixed(2)} rad`);

await arrasta('right');
const direito = await cam();
check('o botão direito continua girando', Math.abs(direito.yaw - esquerdo.yaw) > 0.5,
  `${esquerdo.yaw.toFixed(2)} → ${direito.yaw.toFixed(2)} rad`);

await page.mouse.move(500, 380);
await page.mouse.down({ button: 'left' });
for (let i = 1; i <= 6; i++) await page.mouse.move(500, 380 + i * 16);
await page.mouse.up({ button: 'left' });
await page.waitForTimeout(250);
const olhando = await cam();
check('arrastar na vertical muda a inclinação', Math.abs(olhando.pitch - direito.pitch) > 0.15,
  `${direito.pitch.toFixed(2)} → ${olhando.pitch.toFixed(2)} rad`);

console.log('\n2) A roda aproxima e afasta de verdade');
const antesDoZoom = (await cam()).dist;
await roda(3, -1);
const perto = (await cam()).dist;
check('três cliques para dentro aproximam mais de meio metro',
  antesDoZoom - perto > 0.5, `${antesDoZoom.toFixed(2)} m → ${perto.toFixed(2)} m`);
await roda(12, -1);
const minimo = (await cam()).dist;
await roda(30, 1);
const maximo = (await cam()).dist;
check('a roda cobre o curso inteiro do braço', maximo - minimo > 5,
  `${minimo.toFixed(2)} m … ${maximo.toFixed(2)} m`);
await roda(9, -1);
await page.screenshot({ path: `${dir}/camera.png` });

await enter('apartment=me', '3) Entrar no próprio apartamento é ficar nele');
const casa = await stats();
check('a sala é o apartamento', casa.scene === 'apartment', casa.scene);
check('a chegada NÃO cai dentro da porta de saída', casa.portal === null,
  casa.portal ? `chegou dentro de "${casa.portal}"` : 'nenhum convite na tela');
check('e o convite de sair não está na tela',
  (await page.locator('.portal').count()) === 0);
// "A minha casa" chega como a palavra `me`, e só a conexão sabe que casa isso
// virou. Enquanto a interface ficava com a palavra, ela perguntava
// `/homes/me`, levava 404 e concluía que a casa era de outra pessoa: sem botão
// de decorar, e sem a mobília que o jogador tinha salvo.
check('a casa é reconhecida como sua (botão Decorar)',
  (await page.locator('.build__open').count()) === 1);
await page.locator('.build__open').click();
await page.waitForTimeout(1_200);
check('a paleta abre com o que o jogador possui',
  (await page.locator('.build__item').count()) > 0,
  `${await page.locator('.build__item').count()} peças`);
await page.screenshot({ path: `${dir}/apartamento.png` });

await enter('scene=residential_lobby', '4) E no saguão, cuja saída dá na praça');
const saguao = await stats();
check('a sala é o saguão', saguao.scene === 'residential_lobby', saguao.scene);
check('a chegada NÃO cai dentro de "Voltar à praça"', saguao.portal === null,
  saguao.portal ? `chegou dentro de "${saguao.portal}"` : 'nenhum convite na tela');
await page.screenshot({ path: `${dir}/saguao.png` });

await browser.close();

console.log(`\ncapturas em ${dir}/`);
if (errors.length) console.log(`erros de console: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
const ok = checks.every(Boolean);
console.log(`${ok ? '✅' : '❌'} ${checks.filter(Boolean).length}/${checks.length} verificações passaram.`);
process.exit(ok ? 0 : 1);
