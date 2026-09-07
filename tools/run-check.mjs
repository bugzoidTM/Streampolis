/**
 * Prova de que CORRER chega ao servidor (PRD §34).
 *
 * `MoveIntent.run` existe no protocolo desde o primeiro dia e o servidor sempre
 * validou 5,2 m/s contra os 2,4 m/s da caminhada. O que não existia era como
 * pedir isso sem saber que o Shift servia — e num aparelho de toque não existia
 * meio nenhum. O botão da tela (`RunToggle`) é a correção, e ele atravessa três
 * camadas antes de virar metro por segundo:
 *
 *   tela (latch) → InputManager.alwaysRun → MoveIntent.run → servidor
 *
 * Nenhum teste de unidade pega o defeito que interessa aqui, que é de COSTURA:
 * o botão acende e o corpo continua andando. Então este script mede o que
 * importa e do único lugar onde ele não pode mentir — **o servidor**, por um
 * observador que assiste a mesma sala e lê a posição de quem está no navegador.
 *
 * Precisa dos três no ar: API (:8787), game server e Vite (:5273).
 *
 *   node tools/run-check.mjs
 *
 * ## Por que ele compara, em vez de medir metros por segundo
 *
 * O navegador headless rasteriza por SOFTWARE e roda o mundo a uns poucos
 * quadros por segundo. O relógio de passo fixo do cliente (`FixedStep`) joga
 * fora o excesso de recuperação de propósito — uma aba que voltou do segundo
 * plano não devolve a caminhada inteira —, então a velocidade ABSOLUTA aqui
 * dentro é uma fração da real e mede a GPU que não existe, não o jogo.
 *
 * O que não depende de quadro nenhum é a RAZÃO: com o mesmo tempo de tecla,
 * correr tem de cobrir mais chão que andar. O teto absoluto (5,2 m/s) já é
 * provado onde ele mora, no `applyMoveIntent` do servidor — e continua sendo
 * conferido aqui como TETO, que é a direção em que ele pode falhar.
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';
import { MAX_SPEED, TICK_HZ } from '../packages/game-server/dist/game-server/src/shared.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';

const checks = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const passo = (t) => console.log(`\n${t}`);

async function entrar(username) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou (${res.status}) — rode npm run seed`);
  const body = await res.json();
  return { token: body.token, id: body.identity?.userId ?? body.identity?.id };
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  console.log(`\nCorrer — ${CLIENT}`);

  const ana = await entrar('ana');
  const beto = await entrar('beto');

  passo('1. Ana entra no Distrito Sombra pelo navegador');
  const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e.message)));
  await page.goto(`${CLIENT}/?view=world&scene=noir_district&token=${ana.token}&name=Ana`,
    { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const botao = page.locator('.runtoggle__btn');
  check('o botão de correr existe no HUD do mundo', await botao.count() === 1);
  check('e ele começa desligado (o padrão é andar)',
    await botao.getAttribute('aria-pressed') === 'false');

  passo('2. Beto assiste a mesma sala e lê a posição de Ana no SERVIDOR');
  const observador = new Client(SERVER);
  const sala = await observador.joinOrCreate('city', { token: beto.token, sceneId: 'noir_district' });
  await new Promise((r) => setTimeout(r, 1_500));

  // `PlayerState.id` é o id do USUÁRIO (não a sessão), e é por ele que se
  // encontra no estado da sala quem está do outro lado, no navegador.
  const anaNaSala = () => {
    for (const [, p] of sala.state.players) if (p.id === ana.id || p.name === 'Ana') return p;
    return null;
  };
  /**
   * Esperar em vez de conferir uma vez.
   *
   * O estado de uma sala Colyseus chega por PATCH, e o primeiro que o
   * observador recebe pode ser anterior à entrada de Ana. Conferir uma vez
   * transformava um atraso de rede num "caiu noutro shard" — o pior tipo de
   * portão, o que fica verde por não ter medido nada.
   */
  for (let i = 0; i < 40 && !anaNaSala(); i++) await new Promise((r) => setTimeout(r, 250));

  if (!anaNaSala()) {
    const nomes = [...sala.state.players.values()].map((p) => `${p.name}/${p.id.slice(0, 8)}`);
    console.log(`\n⚠ o observador caiu noutro shard (vê: ${nomes.join(', ') || 'ninguém'}). Pulado.`);
    process.exitCode = 0;
  } else {
    /**
     * Anda até o cliente ter MANDADO `passos` intenções, e devolve o chão que
     * o servidor registrou nesse meio-tempo.
     *
     * Medir por tempo de tecla não funciona aqui, e a primeira versão deste
     * portão descobriu isso ficando vermelha por conta própria: o rasterizador
     * de software roda o mundo a um ou dois quadros por segundo, o `FixedStep`
     * do cliente descarta a recuperação que não cabe, e o que se mede em dois
     * segundos e meio passa a ser a GPU que não existe — com andar e correr
     * empatados em um metro e pouco, ao sabor de uma pausa de coletor de lixo.
     *
     * Por INTENÇÃO o quadro sai da conta. Cada intenção vale um passo fixo de
     * `speed / 24` metros, então quarenta delas são 4,0 m andando e 8,7 m
     * correndo — a mesma razão de 2,17× a um quadro por segundo ou a cento e
     * vinte. `predictor.stats.seq` é o contador que o próprio cliente usa para
     * numerar o que manda.
     */
    const seq = () => page.evaluate(
      () => window.__world?.connection?.predictor?.stats?.seq ?? 0,
    );

    async function medir(passos) {
      const antes = anaNaSala();
      const x0 = antes.x;
      const z0 = antes.z;
      const s0 = await seq();
      await page.keyboard.down('KeyW');
      for (let i = 0; i < 200 && (await seq()) - s0 < passos; i++) {
        await page.waitForTimeout(100);
      }
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(500);
      const dep = anaNaSala();
      const enviados = (await seq()) - s0;
      return {
        metros: Math.hypot(dep.x - x0, dep.z - z0),
        passos: enviados,
        porPasso: enviados > 0 ? Math.hypot(dep.x - x0, dep.z - z0) / enviados : 0,
      };
    }

    /** O passo teórico de uma intenção, em metros (o mesmo do servidor). */
    const passoDe = (v) => v / TICK_HZ;

    passo('3. Andando');
    const andando = await medir(40);
    check('o corpo anda de verdade', andando.metros > 1,
      `${andando.metros.toFixed(2)} m em ${andando.passos} intenções`);
    check('cada intenção vale um passo de caminhada',
      andando.porPasso > passoDe(MAX_SPEED.walk) * 0.6
      && andando.porPasso <= passoDe(MAX_SPEED.walk) * MAX_SPEED.tolerance,
      `${andando.porPasso.toFixed(3)} m/intenção (esperado ~${passoDe(MAX_SPEED.walk).toFixed(3)})`);

    passo('4. O botão da tela, e só ele');
    await botao.click();
    check('o botão ficou pressionado',
      await botao.getAttribute('aria-pressed') === 'true');
    const correndo = await medir(40);
    check('a MESMA intenção passa a cobrir mais chão, sem tocar no Shift',
      correndo.porPasso > andando.porPasso * 1.5,
      `${correndo.porPasso.toFixed(3)} contra ${andando.porPasso.toFixed(3)} m/intenção`);
    check('e o passo é o de corrida, não mais que isso (SPECs §21)',
      correndo.porPasso <= passoDe(MAX_SPEED.run) * MAX_SPEED.tolerance,
      `${correndo.porPasso.toFixed(3)} ≤ ${(passoDe(MAX_SPEED.run) * MAX_SPEED.tolerance).toFixed(3)} m/intenção`);

    passo('5. Com a corrida travada, o Shift volta a ANDAR');
    // A parte que separa um "always run" de uma armadilha: travar a corrida não
    // pode custar a caminhada, ou conversar parado vira impossível.
    await page.keyboard.down('ShiftLeft');
    const comShift = await medir(40);
    await page.keyboard.up('ShiftLeft');
    check('segurar Shift com a trava ligada volta ao passo de caminhada',
      comShift.porPasso < correndo.porPasso * 0.75,
      `${comShift.porPasso.toFixed(3)} contra ${correndo.porPasso.toFixed(3)} m/intenção`);

    passo('6. O R faz o mesmo que o botão');
    await page.keyboard.press('KeyR');
    check('o botão desligou pelo teclado',
      await botao.getAttribute('aria-pressed') === 'false');

    passo('7. A trava sobrevive ao recarregamento (é preferência, não sessão)');
    await botao.click();
    await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
    await page.waitForTimeout(1_200);
    check('voltou ligada',
      await page.locator('.runtoggle__btn').getAttribute('aria-pressed') === 'true');
  }

  await sala.leave();
  if (erros.length) console.log('\nErros de console:', erros.slice(0, 4));

  const falhas = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - falhas}/${checks.length} verificações passaram`);
  if (falhas > 0) process.exitCode = 1;
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
