#!/usr/bin/env node
/**
 * Regera as capturas `hoje-*` do Visual Target.
 *
 * A página em /visual-target/ põe o ALVO ao lado do que o jogo desenha HOJE, e
 * a coluna "hoje" só vale enquanto for verdade. Ela envelhece a cada sprint —
 * e envelhecendo ela mente, que é pior do que não existir: uma comparação
 * publicada e desatualizada convence a equipe a consertar o que já está
 * consertado.
 *
 * Por isso isto é uma ferramenta e não uma sessão de prints. Rodar depois de
 * qualquer mudança visual:
 *
 *   node tools/visual-target-shots.mjs
 *
 * Precisa dos três processos no ar (API :8787, game server :2567, Vite :5273)
 * e do banco de desenvolvimento semeado. Escreve direto em
 * `packages/client/public/visual-target/`, nos mesmos tamanhos das imagens que
 * substitui, para que o layout da página não mude junto.
 *
 * As capturas de cena e de tela passam pelo cliente de verdade, autenticadas:
 * uma captura do modo offline não prova nada sobre o que o jogador vê.
 */
import { chromium } from 'playwright';
import { Client } from 'colyseus.js';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';
const OUT = args.out ?? 'packages/client/public/visual-target';
const QUALITY = Number(args.quality ?? 82);
const TIER = args.tier ?? 'high';
/** `--only=praca,loja` refaz só uma parte; cada cena leva minutos no SwiftShader. */
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const wanted = (key) => !ONLY || ONLY.has(key);

/** Tamanhos das imagens que já estão publicadas; trocá-los mexe no layout. */
const SIZE = {
  figure: { width: 600, height: 800 },
  face: { width: 600, height: 600 },
  close: { width: 700, height: 700 },
  scene: { width: 1100, height: 619 },
  screen: { width: 1100, height: 764 },
};

const GL = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage',
];

const done = [];
const failed = [];

/**
 * Sob SwiftShader uma cena cheia leva bem mais que os 30 s padrão do
 * Playwright para compor um quadro. `shoot.mjs` já usa este teto pelo mesmo
 * motivo.
 */
const SHOT = { type: 'jpeg', quality: QUALITY, timeout: 240_000, animations: 'disabled' };

/** Uma captura que falha não pode derrubar as outras sete. */
async function attempt(name, fn) {
  try {
    await fn();
  } catch (err) {
    failed.push(`${name}: ${err.message.split('\n')[0]}`);
  }
}

async function login(username) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'streampolis-dev' }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou (${res.status})`);
  return res.json();
}

const save = async (name, buffer) => {
  await writeFile(path.join(OUT, name), buffer);
  done.push(`${name} (${(buffer.length / 1024).toFixed(0)} KB)`);
};

/** Abre uma página, espera o mundo aquecer e devolve. */
async function open(browser, url, size, settle) {
  const page = await browser.newPage({ viewport: size });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 })
    .catch(() => errors.push('__ready não chegou'));
  await page.waitForTimeout(settle);
  return { page, errors };
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: GL });

const ana = await login('ana');
const home = await (await fetch(`${API}/me/home`, {
  headers: { authorization: `Bearer ${ana.token}` },
})).json();

// ---------------------------------------------------------------------------
// 1–2. Avatares de corpo inteiro, pelo laboratório
// ---------------------------------------------------------------------------
// O laboratório aceita enquadramento pela URL, então estas duas não dependem de
// nenhum código novo — o que importa é que desenham o MESMO avatar do jogo.
for (const [key, name, start, yaw] of [
  ['feminina', 'hoje-avatar-feminina.jpg', 4, 0.38],
  // Giro POSITIVO nos dois: a chave do laboratório está em +X/+Z, e a -0,34 o
  // figurante sai em contraluz — cabeça em silhueta e rosto invisível, o
  // oposto do que a legenda ao lado afirma.
  ['masculino', 'hoje-avatar-masculino.jpg', 1, 0.30],
]) {
  if (!wanted(key)) continue;
  await attempt(name, async () => {
    const url = `${CLIENT}/?view=lab&count=1&start=${start}&spin=0&yaw=${yaw}`
      + `&dist=3.25&cy=0.92&ly=0.86&exp=0.66&tier=${TIER}`;
    const { page, errors } = await open(browser, url, SIZE.figure, 3500);
    if (errors.length) failed.push(`${name}: ${errors[0]}`);
    await save(name, await page.screenshot(SHOT));
    await page.close();
  });
}

// ---------------------------------------------------------------------------
// 3. Rosto em escala de retrato
// ---------------------------------------------------------------------------
if (wanted('rosto')) {
  const url = `${CLIENT}/?view=lab&matrix=1&spin=0&yaw=0&tier=${TIER}&exp=0.5`;
  const { page, errors } = await open(browser, url, SIZE.face, 1500);
  if (errors.length) failed.push(`hoje-rosto.jpg: ${errors[0]}`);
  const data = await page.evaluate(() => window.__lab.portrait(
    { facePreset: 0, bodyPreset: 0, skinTone: 2, hair: 'hair_wave_01', hairColor: 1, accessory: '' },
    'neutral', 0.42, 1,
  ));
  // O canvas devolve PNG; a página publica JPEG, então converte no navegador.
  const jpeg = await page.evaluate(async ([png, q]) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = png; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/jpeg', q);
  }, [data, QUALITY / 100]);
  await save('hoje-rosto.jpg', Buffer.from(jpeg.split(',')[1], 'base64'));
  await page.close();
}

// ---------------------------------------------------------------------------
// 3b. O rosto em CLOSE, nos três giros que se usa para julgá-lo
// ---------------------------------------------------------------------------
// Estas três eram feitas à mão, recortadas de uma folha de contato, e por isso
// envelheceram sozinhas: o sprint seguinte mexeu no rosto e a página continuou
// mostrando o rosto anterior — exatamente a mentira que esta ferramenta existe
// para não deixar acontecer. Agora saem daqui, com a MESMA câmera e a MESMA luz
// do retrato acima (o rig do laboratório, `exp=0.5`), e o mesmo personagem nos
// três ângulos, que é o que torna a comparação legível.
if (wanted('close')) {
  const url = `${CLIENT}/?view=lab&matrix=1&count=0&spin=0&yaw=0&tier=${TIER}&exp=0.5&blink=0`;
  const { page, errors } = await open(browser, url, SIZE.close, 1500);
  if (errors.length) failed.push(`close: ${errors[0]}`);

  const CLOSE = [
    ['hoje-close-rosto.jpg', 0],
    ['hoje-close-3quartos.jpg', 0.6],
    ['hoje-close-perfil.jpg', 1.57],
  ];
  for (const [name, yaw] of CLOSE) {
    await attempt(name, async () => {
      const png = await page.evaluate(([y]) => window.__lab.portrait(
        { facePreset: 0, bodyPreset: 0, skinTone: 1, hair: 'hair_bob_01', hairColor: 0, accessory: '' },
        'neutral', y, 1.02,
      ), [yaw]);
      const jpeg = await page.evaluate(async ([data, q]) => {
        const img = new Image();
        await new Promise((r) => { img.onload = r; img.src = data; });
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/jpeg', q);
      }, [png, QUALITY / 100]);
      await save(name, Buffer.from(jpeg.split(',')[1], 'base64'));
    });
  }
  await page.close();
}

// ---------------------------------------------------------------------------
// 4–6. Cenas, no cliente de verdade e autenticado
// ---------------------------------------------------------------------------
for (const [key, name, query, settle, framing, move] of [
  ['praca', 'hoje-praca.jpg', `scene=central_plaza`, 11_000, null],
  // Sem trocar o enquadramento: forçar um boom maior num quarto de 8×7 m põe
  // a câmera DENTRO da parede, tanto em `room` (7,2) quanto em `full_body`
  // (4,6). O que o jogo entrega aqui é o boom curto, então a captura anda até
  // um canto — que é o que um jogador faz para ver o próprio quarto.
  ['apartamento', 'hoje-apartamento.jpg', `apartment=${home.home.apartmentId}`, 9000, null, 'walk'],
  ['live', 'hoje-live-room.jpg', `golive=1&title=Sess%C3%A3o%20de%20sexta&category=M%C3%BAsica`, 10_000, null],
]) {
  if (!wanted(key)) continue;
  await attempt(name, async () => {
    const url = `${CLIENT}/?${query}&token=${ana.token}&tier=${TIER}`;
    const { page, errors } = await open(browser, url, SIZE.scene, settle);
    if (errors.length) failed.push(`${name}: ${errors[0]}`);
    if (framing) {
      await page.evaluate((f) => window.__world?.camera?.setFraming(f, true), framing);
      await page.waitForTimeout(2500);
    }
    if (move === 'walk') {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(1600);
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(2500);
    }
    await save(name, await page.screenshot(SHOT));
    await page.close();
  });
}

// ---------------------------------------------------------------------------
// 7–8. Telas de produto. O feed precisa de uma live no ar para ter conteúdo.
// ---------------------------------------------------------------------------
// Duas lives, não uma: uma grade com um card só mostra o layout do feed
// pior do que uma tela vazia mostraria. E sem emoji no título — o headless
// não tem a fonte, e o que sai é um quadrado de tofu numa página publicada.
const rooms = [];
for (const [who, title, category] of [
  ['beto', 'Sessão de sexta', 'Música'],
  ['caio', 'Treino de PK ao vivo', 'PK'],
]) {
  try {
    const account = await login(who);
    const client = new Client(SERVER);
    rooms.push(await client.create('live', {
      token: account.token, title, category, sceneId: 'live_room',
    }));
  } catch (err) {
    failed.push(`live de ${who} não abriu: ${err.message}`);
  }
}
await new Promise((r) => setTimeout(r, 2000));

if (wanted('feed') || wanted('loja')) {
  // Os cards da loja mostram a peça VESTIDA em quem está olhando, então a
  // roupa da conta de captura entra em todos eles. Uma roupa escura come o
  // corpo inteiro do card e a página publica uma grade de silhuetas pretas —
  // então a conta veste algo neutro antes da foto.
  await attempt('roupa da vitrine', async () => {
    const current = await (await fetch(`${API}/me/avatar`, {
      headers: { authorization: `Bearer ${ana.token}` },
    })).json();
    const res = await fetch(`${API}/me/avatar`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ana.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...current.avatar,
        top: 'top_tee_01', bottom: 'bottom_jeans_01', shoes: 'shoes_sneaker_01',
        hair: 'hair_bob_01', accessory: '',
      }),
    });
    if (!res.ok) throw new Error(`vestir falhou (${res.status})`);
    // Salvar a aparência devolve um token NOVO: o antigo ainda veste a roupa
    // velha, e a loja renderizaria os cards com ela.
    const fresh = await res.json();
    if (fresh.token) ana.token = fresh.token;
  });

  await attempt('telas', async () => {
    const { page, errors } = await open(browser, `${CLIENT}/?token=${ana.token}&name=Ana&tier=${TIER}`, SIZE.screen, 6000);
    if (errors.length) failed.push(`telas: ${errors[0]}`);

    // Clicar numa aba enquanto o mundo compõe um quadro espera pela thread
    // principal, e sob SwiftShader isso passa dos 30 s padrão.
    const tab = (name) => page.getByRole('button', { name }).click({ timeout: 120_000 });

    if (wanted('feed')) {
      await tab('Lives');
      await page.waitForSelector('.feed__grid .card', { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3500);
      await save('hoje-feed.jpg', await page.screenshot(SHOT));
    }

    if (wanted('loja')) {
      await tab('Loja');
      await page.waitForSelector('.store__grid .item img', { timeout: 60_000 }).catch(() => {});
      // Cada card renderiza o avatar vestindo a peça, um de cada vez; sem esta
      // pausa metade da grade sai como esqueleto.
      await page.waitForTimeout(12_000);
      await save('hoje-loja.jpg', await page.screenshot(SHOT));
    }
    await page.close();
  });
}

for (const room of rooms) { try { room.leave(); } catch { /* a sala cai sozinha */ } }
await browser.close();

// Carimba a página com a data e o commit de onde as capturas vieram. Foi a
// falta disto que deixou a comparação envelhecer sem ninguém notar: as imagens
// não dizem de qual build são, e uma coluna "hoje" que mente é pior do que uma
// coluna vazia.
// Vale TAMBÉM para uma regeração parcial. Pular o carimbo quando se usa
// `--only` foi o que deixou a página anunciar um build e mostrar imagens de
// outro: quem regera só o rosto continua regerando, e a data continua sendo a
// data das imagens novas.
if (done.length) {
  await attempt('carimbo', async () => {
    const page = path.join(OUT, 'index.html');
    const html = await readFile(page, 'utf8');
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const when = new Date().toISOString().slice(0, 10);
    const parte = ONLY ? ` (parcial: ${[...ONLY].join(', ')})` : '';
    const stamp = `Capturas <b>Hoje</b>: build <code>${sha}</code>, ${when}${parte}.`;
    const next = html.replace(
      /(<span id="hoje-stamp">)[\s\S]*?(<\/span>)/,
      `$1${stamp}$2`,
    );
    if (next === html) {
      failed.push('carimbo: não achei <span id="hoje-stamp"> na página');
      return;
    }
    await writeFile(page, next);
    done.push(`index.html carimbado (${sha}, ${when})`);
  });
}

console.log(`\n${done.length} capturas regeradas em ${OUT}:`);
for (const d of done) console.log(`  ${d}`);
if (failed.length) {
  console.log('\nAvisos:');
  for (const f of failed) console.log(`  ! ${f}`);
}
process.exit(failed.length ? 1 : 0);
