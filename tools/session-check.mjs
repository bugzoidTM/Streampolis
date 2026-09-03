/**
 * A sessão dura mais que quinze minutos?
 *
 * O access token vence em 15 min por decisão de segurança (SPECs §36). Isto
 * confere as duas metades do que faz esse número ser aceitável: o refresh
 * ROTATIVO no servidor, e o cliente que renova sozinho antes de a praça
 * responder `expired`.
 *
 * O bug que originou este arquivo: sem renovação, quinze minutos depois de
 * entrar o jogo caía em "modo offline" na praça e a porta do apartamento
 * devolvia o jogador à praça — os dois sem uma palavra na tela.
 *
 * `node tools/session-check.mjs [--url=https://streampolis.nutef.com]`
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const BASE = args.url ?? 'https://streampolis.nutef.com';
const API = `${BASE}/api`;

const checks = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const post = async (path, body) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const entrar = async (username = 'ana') => (await post('/auth/dev-login', { username })).body;

// ------------------------------------------------------- 1) o contrato ---

console.log('\n1) O par de tokens e a rotação');

const inicial = await entrar();
check('a entrada devolve access E refresh', Boolean(inicial.token && inicial.refreshToken));
check('o access é curto (§36)', inicial.expiresIn <= 15 * 60, `${inicial.expiresIn}s`);
check('o refresh é longo', inicial.refreshExpiresIn >= 24 * 3600, `${inicial.refreshExpiresIn}s`);

const renovado = await post('/auth/refresh', { refreshToken: inicial.refreshToken });
check('renovar devolve 200', renovado.status === 200, `HTTP ${renovado.status}`);
check('o access mudou', renovado.body.token && renovado.body.token !== inicial.token);
check('o refresh TAMBÉM mudou (rotativo)',
  renovado.body.refreshToken && renovado.body.refreshToken !== inicial.refreshToken);
check('a identidade volta junto', renovado.body.identity?.userId === inicial.identity.userId);

const reuso = await post('/auth/refresh', { refreshToken: inicial.refreshToken });
check('reapresentar o refresh já usado é recusado',
  reuso.status === 401 && reuso.body.reason === 'reused', JSON.stringify(reuso.body));

const depoisDoReuso = await post('/auth/refresh', { refreshToken: renovado.body.refreshToken });
check('e o reúso derruba a FAMÍLIA inteira, não só o token repetido',
  depoisDoReuso.status === 401, `HTTP ${depoisDoReuso.status}`);

const sessao = await entrar();
const saiu = await post('/auth/logout', { refreshToken: sessao.refreshToken });
check('sair responde ok', saiu.status === 200);
const depoisDoLogout = await post('/auth/refresh', { refreshToken: sessao.refreshToken });
check('e o refresh revogado não renova mais', depoisDoLogout.status === 401);

// ------------------------------------------ 2) o cliente, com o vencido ---

console.log('\n2) Access VENCIDO no navegador, refresh válido');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});

const viva = await entrar();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// A sessão é plantada UMA vez, com `evaluate` depois de abrir a origem — e não
// com `addInitScript`, que roda a cada navegação e replantaria o refresh
// ANTIGO nas etapas seguintes. O servidor leria isso como reúso e derrubaria a
// família: o teste mataria a sessão que ele mesmo está medindo.
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.evaluate(({ access, refresh }) => {
  localStorage.setItem('streampolis.token', access);
  localStorage.setItem('streampolis.refresh', refresh);
  // Vencido há uma hora: o cliente tem de renovar ANTES de tentar a sala.
  localStorage.setItem('streampolis.expires', String(Date.now() - 3_600_000));
}, { access: viva.token, refresh: viva.refreshToken });

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(2_500);

const praca = await page.evaluate(() => window.__lab?.stats?.() ?? null);
check('não pediu personagem de novo', await page.locator('.enter__title').count() === 0);
check('a praça está ONLINE, não em "modo offline"', praca?.online === true,
  praca ? `cena ${praca.scene}, online=${praca.online}` : 'sem stats');
const guardado = await page.evaluate(() => localStorage.getItem('streampolis.token'));
check('o token guardado foi TROCADO pelo renovado', Boolean(guardado) && guardado !== viva.token);

// ------------------------------------------- 3) a porta do apartamento ---

console.log('\n3) A porta do apartamento com a sessão renovada');

await page.goto(`${BASE}/?apartment=me`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 }).catch(() => {});
await page.waitForTimeout(2_500);
const casa = await page.evaluate(() => window.__lab?.stats?.() ?? null);
check('entrou no apartamento (não voltou para a praça)',
  casa?.scene === 'apartment', casa ? `cena ${casa.scene}` : 'sem stats');
check('e a sala é de verdade', casa?.online === true);

// -------------------------- 3b) o botão, clicado como o jogador clica ---

console.log('\n3b) O caminho real: perfil → "Ir para o meu apartamento"');

// `?apartment=me` prova a INTENÇÃO na carga da página; isto prova a TRANSIÇÃO,
// que é onde a queixa nasceu: "clico em entrar no apartamento e volto para a
// praça". O World remonta com uma intenção nova, e é essa remontagem que
// falhava calada.
//
// O botão do perfil, e não a porta do saguão, porque a porta exige ANDAR até
// ela: sobre rasterização por software o jogo roda a poucos quadros por
// segundo, e a caminhada mediria o rasterizador, não a viagem.
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 120_000 }).catch(() => {});
await page.waitForTimeout(1_500);

const stats = () => page.evaluate(() => window.__lab?.stats?.() ?? null);
await page.locator('.nav__item', { hasText: 'Perfil' }).click();
const irParaCasa = page.locator('button', { hasText: 'Ir para o meu apartamento' }).first();
await irParaCasa.waitFor({ timeout: 30_000 }).catch(() => {});
check('o perfil oferece ir para casa', await irParaCasa.count() > 0);

if (await irParaCasa.count() > 0) {
  await irParaCasa.click();
  await page.waitForFunction(
    () => window.__lab?.stats?.()?.scene === 'apartment', { timeout: 90_000 },
  ).catch(() => {});
  await page.waitForTimeout(1_500);
  const dentro = await stats();
  check('clicar leva ao APARTAMENTO, não de volta à praça',
    dentro?.scene === 'apartment', `cena ${dentro?.scene}`);
  check('e a sala é de verdade', dentro?.online === true);
}

// --------------------------------------------- 4) a sessão que acabou ---

console.log('\n4) Sessão MORTA: a tela diz, em vez de fingir "offline"');

const morta = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await morta.addInitScript(() => {
  localStorage.setItem('streampolis.token', 'eyJhbGciOiJIUzI1NiJ9.morto.morto');
  localStorage.setItem('streampolis.refresh', 'refresh-que-nao-existe-em-lugar-nenhum');
  localStorage.setItem('streampolis.expires', String(Date.now() - 3_600_000));
});
await morta.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await morta.waitForSelector('.enter__title', { timeout: 30_000 }).catch(() => {});
check('a porta de entrada volta', await morta.locator('.enter__title').count() > 0);
const avisoTexto = await morta.locator('.enter__error').innerText().catch(() => '');
check('e ela DIZ que a sessão expirou', /sess/i.test(avisoTexto), avisoTexto || 'sem aviso');

// ------------------------------------------------- 5) duas abas abertas ---

console.log('\n5) Duas abas renovando ao mesmo tempo');

// A sessão é do NAVEGADOR, não da aba. Duas abas com o mesmo refresh o
// apresentariam duas vezes; a segunda seria lida como reúso e o servidor
// derrubaria a FAMÍLIA — as duas abas expulsas por uma proteção contra roubo
// que ninguém sofreu. As abas precisam se coordenar pelo `localStorage`.
const dupla = await browser.newContext({ viewport: { width: 1024, height: 700 } });
const par = await entrar('beto');
const abaA = await dupla.newPage();
await abaA.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await abaA.evaluate(({ access, refresh }) => {
  localStorage.setItem('streampolis.token', access);
  localStorage.setItem('streampolis.refresh', refresh);
  localStorage.setItem('streampolis.expires', String(Date.now() - 3_600_000));
}, { access: par.token, refresh: par.refreshToken });

// As duas ao mesmo tempo, no mesmo contexto: mesmo `localStorage`, sessão uma
// só. Ambas acordam com o access vencido e ambas querem renovar.
const abaB = await dupla.newPage();
await Promise.all([
  abaA.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
  abaB.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
]);
await Promise.all([
  abaA.waitForFunction(() => window.__ready === true, { timeout: 120_000 }).catch(() => {}),
  abaB.waitForFunction(() => window.__ready === true, { timeout: 120_000 }).catch(() => {}),
]);
await abaA.waitForTimeout(8_000);

const vivaA = await abaA.evaluate(() => window.__lab?.stats?.()?.online ?? null);
const vivaB = await abaB.evaluate(() => window.__lab?.stats?.()?.online ?? null);
check('a primeira aba continua online', vivaA === true, `online=${vivaA}`);
check('a segunda também — nenhuma foi expulsa por "reúso"', vivaB === true, `online=${vivaB}`);
const naPorta = await abaA.locator('.enter__title').count() + await abaB.locator('.enter__title').count();
check('nenhuma das duas voltou para a porta de entrada', naPorta === 0);
const guardadoDupla = await abaA.evaluate(() => localStorage.getItem('streampolis.token'));
check('e a sessão foi renovada UMA vez, para as duas',
  Boolean(guardadoDupla) && guardadoDupla !== par.token);

await browser.close();
const falhas = checks.filter((c) => !c).length;
console.log(falhas === 0
  ? `\n✅ ${checks.length}/${checks.length} verificações passaram.`
  : `\n❌ ${falhas} de ${checks.length} falharam.`);
process.exit(falhas === 0 ? 0 : 1);
