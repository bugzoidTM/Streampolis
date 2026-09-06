#!/usr/bin/env node
/**
 * Release check: a primeira hora de DOIS jogadores novos, do zero.
 *
 * Todos os outros e2e do repositório entram por `POST /auth/dev-login` — a
 * porta que a Public Beta fecha. Isso os torna cegos exatamente para o que a
 * beta muda: eles continuariam verdes numa API onde ninguém consegue se
 * cadastrar, e vermelhos numa beta saudável só porque a porta que eles usam não
 * existe mais. Este arquivo existe para ser o contrário disso: ele NÃO usa
 * `dev-login` em lugar nenhum, cria as duas contas pelo mesmo formulário que o
 * jogador usa, e faz com elas a volta inteira —
 *
 *   cadastro → avatar → praça → amizade → encontrar → apartamento
 *            → live → gift → PK
 *
 * O critério é sempre o mesmo: o que o SERVIDOR observou. Nada aqui pergunta ao
 * cliente se ele acha que deu certo — a amizade é lida na lista da API, o
 * encontro é o `roomId` batendo, o gift é a carteira debitada e a linha de
 * extrato, o PK é a batalha gravada no banco.
 *
 * ## Como rodar
 *
 * Desenvolvimento (API e game server locais, banco de desenvolvimento):
 *
 *   node tools/release-check.mjs
 *
 * Contra a stack publicada, de DENTRO do container da API — que é onde o
 * Postgres da produção é alcançável (ver "moeda", abaixo):
 *
 *   CID=$(docker ps --filter name=streampolis_sp-api -q | head -1)
 *   source /root/streampolis-deploy/.env
 *   docker exec -w /app \
 *     -e DATABASE_URL="postgres://streampolis:${SP_DB_PASSWORD}@sp-db:5432/streampolis" \
 *     $CID node tools/release-check.mjs \
 *       --api=http://sp-api:8787 --ws=ws://sp-game:2567
 *
 * ## Duas contas, e o que elas deixam para trás
 *
 * As contas são criadas com nome `rc_<carimbo>_a`/`_b` e e-mail em
 * `@release-check.streampolis` — NUNCA em `@dev.streampolis`, o domínio das
 * fixtures: uma conta deste teste não pode aparecer na fileira da tela de
 * entrada nem ser aberta por `dev-login` (e o passo 1 confere isso).
 *
 * Elas FICAM no banco depois da rodada, e isso é decisão, não esquecimento:
 * gift e PK escrevem em `wallet_transactions` e `pk_matches`, que referenciam
 * o usuário com ON DELETE RESTRICT porque extrato e histórico são imutáveis.
 * Apagar a conta exigiria apagar o extrato — que é justamente o que o projeto
 * decidiu nunca fazer. Uma conta de teste por rodada é o preço; o prefixo `rc_`
 * é o que permite reconhecê-las depois.
 *
 * ## Moeda: por que este teste precisa do banco
 *
 * Não existe (ainda) caminho de produto para uma conta nova ter Coins: o
 * webhook de pagamento que chamaria `purchaseCoins` não está no ar, e o `seed`
 * — que dá saldo às fixtures — recusa-se a rodar em produção. Sem Coins não há
 * gift, e sem gift não há placar de PK.
 *
 * A saída é creditar a conta pelo MESMO código que o webhook chamará
 * (`purchaseCoins`, com `paymentId` marcado como release-check), o que exige
 * `DATABASE_URL`. É o único passo que não passa pela API pública, e está
 * anotado como tal na saída do teste — ele é uma bengala do ambiente, não uma
 * funcionalidade nova.
 *
 * ## Orçamento de /auth
 *
 * Em produção o limitador deixa passar 10 chamadas de /auth por minuto POR IP,
 * e esta rodada gasta 6. Duas rodadas seguidas no mesmo minuto estouram: se vir
 * 429 no cadastro, espere um minuto. É o limitador funcionando.
 */
import { Client } from 'colyseus.js';

// Nomes de sala: protocolo, iguais nos dois lados (client/NetworkClient.ts e
// game-server/index.ts). Repetidos aqui de propósito — importar o índice do
// game server construiria um servidor inteiro só para ler três strings.
const ROOM_CITY = 'city';
const ROOM_APARTMENT = 'apartment';
const ROOM_LIVE = 'live';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const API = (args.api ?? process.env.API_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = (args.ws ?? process.env.GAME_SERVER_URL ?? 'ws://127.0.0.1:2567').replace(/\/$/, '');
/** `beta` (porta fechada), `demo` (porta aberta) ou `auto` (pergunta ao /health). */
const EXPECT = args.expect ?? 'auto';
const COINS = Number(args.coins ?? 400);

let failures = 0;
let checks = 0;
const notes = [];
const check = (label, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (text) => { notes.push(text); console.log(`  · ${text}`); };
const step = (label) => console.log(`\n${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 8_000, intervalMs = 60) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

/**
 * Espera por algo que só a API sabe responder, com intervalo folgado: 20
 * requisições por segundo contra rota autenticada gastam a cota do limitador em
 * segundos, e aí o teste passa a medir o rate limit em vez do que veio testar.
 */
const waitForApi = (label, predicate, timeoutMs = 10_000) =>
  waitFor(label, predicate, timeoutMs, 500);

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}
const asUser = (token) => ({ authorization: `Bearer ${token}` });

/** Carimbo curto e único: o username aceita só [A-Za-z0-9_.] e 24 caracteres. */
const STAMP = Date.now().toString(36);
const conta = (sufixo) => ({
  username: `rc_${STAMP}_${sufixo}`,
  email: `rc_${STAMP}_${sufixo}@release-check.streampolis`,
  password: `Rc!${STAMP}#${sufixo}9`,
});

async function registrar(pessoa) {
  const { status, body } = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: pessoa.username, email: pessoa.email, password: pessoa.password }),
  });
  if (status === 429) {
    throw new Error('429 no cadastro: o limitador de /auth (10/min em produção) ainda está '
      + 'contando a rodada anterior. Espere um minuto e rode de novo.');
  }
  if (status !== 201) {
    throw new Error(`cadastro de ${pessoa.username} falhou (${status}): ${JSON.stringify(body)}`);
  }
  return { ...pessoa, ...body, userId: body.identity?.userId };
}

/**
 * Credita Coins pelo mesmo caminho do webhook de pagamento. Único passo que
 * fala com o banco — ver o cabeçalho deste arquivo.
 */
async function creditarCoins(userId, coins) {
  const localApi = /^(https?:)?\/\/(127\.0\.0\.1|localhost)\b/.test(API) || API.startsWith('http://127.0.0.1');
  if (!process.env.DATABASE_URL && !localApi) {
    throw new Error('DATABASE_URL ausente. A API sob teste não é local, então o default de '
      + 'desenvolvimento apontaria para o banco errado — e creditar Coins na base errada é pior '
      + 'do que não creditar. Rode de dentro do container da API com DATABASE_URL definida.');
  }
  const { purchaseCoins } = await import('../packages/api/src/economy/EconomyService.ts');
  const { closePool } = await import('../packages/api/src/db/pool.ts');
  try {
    await purchaseCoins({
      userId,
      coins,
      paymentId: `release-check:${STAMP}`,
      idempotencyKey: `release_check_topup_${STAMP}_${userId}`,
    });
  } finally {
    await closePool();
  }
}

async function entrarNaCidade(token, sceneId) {
  const client = new Client(WS);
  const room = await client.joinOrCreate(ROOM_CITY, { token, sceneId });
  room.onMessage('chatMessage', () => {});
  room.onMessage('notice', () => {});
  await waitFor(`estado inicial (${sceneId})`, () => room.state?.players !== undefined);
  return { client, room };
}

const jogadorDe = (room, userId) => [...room.state.players.values()].find((p) => p.id === userId);

async function main() {
  console.log(`\nRelease check — API ${API} · game server ${WS}`);

  // ------------------------------------------------------------- ambiente ---
  step('0) O ambiente é o que se espera dele');
  const health = await api('/health');
  if (health.status !== 200) {
    console.error(`\n💥 a API não respondeu em ${API} (${health.status}). Suba a stack antes.`);
    process.exit(2);
  }
  const env = health.body?.env;
  const modo = EXPECT === 'auto' ? (env === 'production' ? 'beta' : 'demo') : EXPECT;
  check('a API está de pé e fala do próprio ambiente', typeof env === 'string', JSON.stringify(health.body));
  check(`o ambiente declarado bate com o modo esperado (${modo})`,
    modo === 'beta' ? env === 'production' : env !== 'production', `env=${env}`);

  const devLogin = await api('/auth/dev-login', { method: 'POST', body: JSON.stringify({ username: 'ana' }) });
  const demoAccounts = await api('/auth/demo-accounts');
  if (modo === 'beta') {
    check('a porta sem senha está fechada (dev-login → 404)', devLogin.status === 404, `status=${devLogin.status}`);
    check('e a fileira de personagens some junto (demo-accounts → 404)',
      demoAccounts.status === 404, `status=${demoAccounts.status}`);
  } else {
    check('a demonstração continua oferecendo a porta aberta', devLogin.status === 200 || devLogin.status === 404,
      `status=${devLogin.status}`);
    note('modo demonstração: a beta é o que se testa em produção — rode com --expect=beta lá.');
  }

  // ------------------------------------------------------------- cadastro ---
  step('1) Cadastro: duas contas novas pelo mesmo formulário do jogador');
  const A = await registrar(conta('a'));
  const B = await registrar(conta('b'));
  check('a primeira conta nasceu com sessão completa',
    Boolean(A.token && A.refreshToken && A.userId), JSON.stringify({ token: Boolean(A.token), refresh: Boolean(A.refreshToken) }));
  check('a segunda também', Boolean(B.token && B.refreshToken && B.userId));
  check('o nome de exibição é o username escolhido', A.identity?.displayName === A.username,
    `displayName=${A.identity?.displayName}`);

  const repetido = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: A.username, email: `outro_${STAMP}@release-check.streampolis`, password: 'Outra!Senha#7' }),
  });
  check('username repetido é recusado com 409', repetido.status === 409,
    `status=${repetido.status} ${JSON.stringify(repetido.body)}`);

  const relogin = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username: A.username, password: A.password }),
  });
  check('a conta nova volta a entrar com a própria senha', relogin.status === 200, `status=${relogin.status}`);

  if (modo !== 'beta') {
    const invasao = await api('/auth/dev-login', { method: 'POST', body: JSON.stringify({ username: A.username }) });
    check('mesmo na demonstração, conta de jogador NÃO abre por dev-login', invasao.status === 404,
      `status=${invasao.status}`);
    const fileira = (demoAccounts.body?.accounts ?? []).map((c) => c.username);
    check('e ela não aparece na fileira da tela de entrada', !fileira.includes(A.username), fileira.join(', '));
  }

  const carteiraInicial = (await api('/me/wallet', { headers: asUser(B.token) })).body;
  check('conta nova nasce com carteira zerada', carteiraInicial.coins === 0, `coins=${carteiraInicial.coins}`);

  // --------------------------------------------------------------- avatar ---
  step('2) Avatar: a aparência muda, e é a API que assina a roupa');
  const avatarAntes = (await api('/me/avatar', { headers: asUser(A.token) })).body.avatar;
  check('a conta nasceu com um avatar', Boolean(avatarAntes?.top), JSON.stringify(avatarAntes ?? {}));

  // Só campos numéricos e as peças que a própria conta já tem: uma conta nova
  // ganha o que é grátis no catálogo, e pedir peça paga aqui mediria o gate de
  // posse (que tem teste próprio) em vez da troca de roupa.
  const novoTom = (avatarAntes.skinTone + 2) % 8;
  const novoAvatar = { ...avatarAntes, skinTone: novoTom, hairColor: (avatarAntes.hairColor + 1) % 6, height: 1.04 };
  const posto = await api('/me/avatar', {
    method: 'PUT', headers: asUser(A.token), body: JSON.stringify(novoAvatar),
  });
  check('a troca de roupa foi aceita', posto.status === 200, JSON.stringify(posto.body));
  check('nenhuma peça foi rejeitada', (posto.body.rejected ?? []).length === 0, JSON.stringify(posto.body.rejected));
  check('a API devolveu token novo junto (senão o jogo continuaria com a roupa velha)',
    typeof posto.body.token === 'string' && posto.body.token !== A.token);
  A.token = posto.body.token ?? A.token;

  const avatarDepois = (await api('/me/avatar', { headers: asUser(A.token) })).body.avatar;
  check('e a aparência ficou gravada', avatarDepois?.skinTone === novoTom,
    `skinTone=${avatarDepois?.skinTone}`);

  const passos1 = (await api('/me/onboarding', { headers: asUser(A.token) })).body;
  check('a volta guiada marcou "criar avatar"',
    (passos1.steps ?? []).some((s) => s.step === 'create_avatar' && s.done));

  // ----------------------------------------------------------------- praça ---
  step('3) Praça: as duas contas entram no mundo com o token da API');
  const aCidade = await entrarNaCidade(A.token, 'central_plaza');
  const aPlayer = jogadorDe(aCidade.room, A.userId);
  check('a primeira conta entrou autenticada', Boolean(aPlayer), 'jogador não apareceu no estado');
  check('o nome no mundo vem da API', aPlayer?.name === A.username, `name=${aPlayer?.name}`);
  check('a roupa em cena é a que a API assinou', aPlayer?.avatar?.skinTone === novoTom,
    `skinTone em cena=${aPlayer?.avatar?.skinTone}`);

  // A outra conta começa em OUTRA cena de propósito: é o que faz o "Encontrar"
  // do passo 5 significar alguma coisa. Duas pessoas entrando na praça ao mesmo
  // tempo cairiam no mesmo shard sozinhas, e o teste passaria sem testar nada.
  const bLoja = await entrarNaCidade(B.token, 'stream_store');
  check('a segunda conta entrou em outra cena', bLoja.room.state.sceneId === 'stream_store',
    bLoja.room.state.sceneId);

  const presencaDe = async (token) => (await api('/me/presence', { headers: asUser(token) })).body.presence;
  const publicou = await waitForApi('presença publicada', async () => Boolean(await presencaDe(A.token)));
  const ondeA = await presencaDe(A.token);
  check('o game server publicou a presença sozinho', publicou);
  check('a API sabe a cena e o shard exatos',
    ondeA?.sceneId === 'central_plaza' && ondeA?.roomId === aCidade.room.roomId,
    JSON.stringify(ondeA));

  // -------------------------------------------------------------- amizade ---
  step('4) Amizade: convite, aceite, e o portão que ela abre');
  const semAmizade = await api(`/friends/${A.userId}/location`, { headers: asUser(B.token) });
  check('sem amizade, ninguém entrega o endereço de ninguém (403)', semAmizade.status === 403,
    `status=${semAmizade.status}`);

  const convite = await api(`/friends/${B.userId}`, { method: 'POST', headers: asUser(A.token) });
  check('o convite foi criado', convite.status === 200 && convite.body.state === 'outgoing',
    JSON.stringify(convite.body));
  const recebidos = (await api('/me/friends', { headers: asUser(B.token) })).body;
  check('e chegou como convite recebido do outro lado',
    (recebidos.incoming ?? []).some((f) => f.userId === A.userId), JSON.stringify(recebidos.incoming));

  const aceite = await api(`/friends/${A.userId}/accept`, { method: 'POST', headers: asUser(B.token) });
  check('o aceite fechou a amizade', aceite.status === 200 && aceite.body.state === 'friends',
    JSON.stringify(aceite.body));
  const listaA = (await api('/me/friends', { headers: asUser(A.token) })).body;
  check('os dois se veem na lista de amigos',
    (listaA.friends ?? []).some((f) => f.userId === B.userId), JSON.stringify(listaA.friends));

  // ------------------------------------------------------------- encontrar ---
  step('5) Encontrar: a segunda conta vai parar na sala EXATA da primeira');
  const localizado = await waitForApi('localização do amigo', async () => {
    const r = await api(`/friends/${A.userId}/location`, { headers: asUser(B.token) });
    return r.status === 200 && Boolean(r.body.presence?.roomId);
  });
  const local = (await api(`/friends/${A.userId}/location`, { headers: asUser(B.token) })).body.presence;
  check('agora a amizade abre o endereço', localizado && Boolean(local?.roomId), JSON.stringify(local));
  check('e o endereço é o shard de verdade em que o amigo está',
    local?.roomId === aCidade.room.roomId, `${local?.roomId} ≠ ${aCidade.room.roomId}`);

  await bLoja.room.leave();
  const bEncontro = new Client(WS);
  let caiuNoMatchmaking = false;
  let bRoom;
  try {
    // Réplica fiel de `meetAt` no cliente: tenta o shard exato e só cai no
    // matchmaking se ele recusar.
    bRoom = await bEncontro.joinById(local.roomId, { token: B.token });
  } catch {
    caiuNoMatchmaking = true;
    bRoom = await bEncontro.joinOrCreate(ROOM_CITY, { token: B.token, sceneId: 'central_plaza' });
  }
  bRoom.onMessage('chatMessage', () => {});
  bRoom.onMessage('notice', () => {});
  await waitFor('estado do encontro', () => bRoom.state?.players !== undefined);
  check('o encontro não caiu no matchmaking', caiuNoMatchmaking === false);
  check('as duas contas estão na MESMA sala', bRoom.roomId === aCidade.room.roomId,
    `${bRoom.roomId} vs ${aCidade.room.roomId}`);
  const seVeem = await waitFor('uma enxergar a outra', () => aCidade.room.state.players.size >= 2);
  check('e uma enxerga a outra lá dentro', seVeem, `a primeira vê ${aCidade.room.state.players.size}`);

  await bRoom.leave();
  await aCidade.room.leave();

  // ----------------------------------------------------------- apartamento ---
  step('6) Apartamento: a casa nasce, fecha para estranhos e abre para amigo');
  const casa = (await api('/me/home', { headers: asUser(A.token) })).body.home;
  check('a conta nova tem apartamento na primeira visita', Boolean(casa?.apartmentId), JSON.stringify(casa ?? {}));

  const fechada = await api('/me/home/visibility', {
    method: 'PUT', headers: asUser(A.token), body: JSON.stringify({ visibility: 'private' }),
  });
  check('o dono consegue trancar a casa', fechada.status === 200, JSON.stringify(fechada.body));
  const negada = await api(`/homes/${casa.apartmentId}`, { headers: asUser(B.token) });
  check('trancada, nem o amigo entra (403)', negada.status === 403, `status=${negada.status}`);

  await api('/me/home/visibility', {
    method: 'PUT', headers: asUser(A.token), body: JSON.stringify({ visibility: 'friends' }),
  });
  const permitida = await api(`/homes/${casa.apartmentId}`, { headers: asUser(B.token) });
  check('aberta para amigos, o amigo enxerga a planta', permitida.status === 200, `status=${permitida.status}`);

  const aCasaCliente = new Client(WS);
  const aCasa = await aCasaCliente.joinOrCreate(ROOM_APARTMENT, { token: A.token, apartmentId: casa.apartmentId });
  aCasa.onMessage('chatMessage', () => {});
  await waitFor('a dona dentro de casa', () => aCasa.state?.players !== undefined);
  const bCasaCliente = new Client(WS);
  const bCasa = await bCasaCliente.joinOrCreate(ROOM_APARTMENT, { token: B.token, apartmentId: casa.apartmentId });
  bCasa.onMessage('chatMessage', () => {});
  const visitaEntrou = await waitFor('a visita dentro', () => aCasa.state.players.size >= 2);
  check('a visita entra na casa do amigo', visitaEntrou, `a dona vê ${aCasa.state.players.size}`);

  await waitForApi('presença de apartamento', async () => (await presencaDe(B.token))?.sceneId === 'apartment');
  const passosB1 = (await api('/me/onboarding', { headers: asUser(B.token) })).body;
  check('a volta guiada marcou "visitar apartamento" para a visita',
    (passosB1.steps ?? []).some((s) => s.step === 'visit_apartment' && s.done));

  await bCasa.leave();
  await aCasa.leave();

  // ------------------------------------------------------------------ live ---
  step('7) Live: uma transmite, a outra assiste, e a API sabe dos dois');
  const aLiveCliente = new Client(WS);
  const aLive = await aLiveCliente.create(ROOM_LIVE, {
    token: A.token, title: `Release check ${STAMP}`, category: 'música',
  });
  // O anfitrião também precisa declarar o que ouve: colyseus.js reclama em voz
  // alta de mensagem sem handler, e o barulho esconderia um erro de verdade.
  for (const tipo of ['chatMessage', 'notice', 'giftEvent', 'stageInvite', 'pkResult', 'follow']) {
    aLive.onMessage(tipo, () => {});
  }
  await waitFor('a live existir', () => aLive.state?.liveId !== undefined);

  const bLiveCliente = new Client(WS);
  const bLive = await bLiveCliente.joinById(aLive.roomId, { token: B.token });
  const gifts = [];
  const avisos = [];
  bLive.onMessage('giftEvent', (g) => gifts.push(g));
  bLive.onMessage('notice', (n) => avisos.push(n));
  for (const tipo of ['chatMessage', 'stageInvite', 'pkResult', 'follow']) {
    bLive.onMessage(tipo, () => {});
  }
  await waitFor('a plateia contar', () => (bLive.state?.viewers ?? 0) >= 1);
  check('a espectadora entrou na live', (bLive.state?.viewers ?? 0) >= 1, `viewers=${bLive.state?.viewers}`);

  await waitForApi('presença de palco', async () => (await presencaDe(A.token))?.kind === 'streaming');
  check('quem transmite aparece transmitindo', (await presencaDe(A.token))?.kind === 'streaming');
  check('quem assiste aparece assistindo', (await presencaDe(B.token))?.kind === 'watching_live');

  const feed = (await api('/lives')).body.lives ?? [];
  check('a live entrou no feed público', feed.some((l) => l.hostId === A.userId), `${feed.length} lives`);

  // ------------------------------------------------------------------ gift ---
  step('8) Gift: a moeda sai de uma carteira de verdade');
  await creditarCoins(B.userId, COINS);
  note(`carteira da espectadora creditada com ${COINS} Coins pelo caminho do webhook `
    + '(purchaseCoins) — único passo fora da API pública; ver o cabeçalho deste arquivo.');
  const antes = (await api('/me/wallet', { headers: asUser(B.token) })).body;
  check('o crédito chegou à carteira', antes.coins === COINS, `coins=${antes.coins}`);

  const chave = `release_check_${STAMP}_gift`;
  bLive.send('gift', { giftId: 'g_star', quantity: 1, idempotencyKey: chave });
  const transmitiu = await waitFor('o gift ser transmitido', () => gifts.length > 0);
  check('o gift chegou à sala', transmitiu, avisos.map((a) => a.code).join(', '));

  const depois = (await api('/me/wallet', { headers: asUser(B.token) })).body;
  check('a carteira foi debitada pelo preço do catálogo (99)', antes.coins - depois.coins === 99,
    `${antes.coins} → ${depois.coins}`);

  bLive.send('gift', { giftId: 'g_star', quantity: 1, idempotencyKey: chave });
  await sleep(900);
  const replay = (await api('/me/wallet', { headers: asUser(B.token) })).body;
  check('reenviar com a mesma chave não cobra de novo', replay.coins === depois.coins,
    `${depois.coins} → ${replay.coins}`);
  check('e também não duplica o evento na sala', gifts.length === 1, `${gifts.length} eventos`);

  const extrato = (await api('/me/ledger?limit=5', { headers: asUser(B.token) })).body;
  check('o débito virou linha de extrato', (extrato.entries ?? [])[0]?.amount === -99,
    JSON.stringify((extrato.entries ?? [])[0]?.amount));

  // -------------------------------------------------------------------- PK ---
  step('9) PK: convite para o palco, batalha e resultado gravado');
  aLive.send('invite', { userId: B.userId });
  await sleep(500);
  bLive.send('acceptStage', {});
  const subiu = await waitFor('a segunda conta no palco', () => aLive.state.players.size === 2);
  check('o convite levou a espectadora ao palco', subiu, `no palco: ${aLive.state.players.size}`);

  aLive.send('startPK', { opponentId: B.userId });
  const ativo = await waitFor('o PK começar', () => bLive.state.pk.phase === 'ACTIVE', 12_000);
  check('a batalha começou', ativo, `fase=${bLive.state.pk.phase}`);
  await waitForApi('presença de batalha', async () => (await presencaDe(A.token))?.kind === 'in_pk');
  check('durante o PK a presença diz "em batalha"', (await presencaDe(A.token))?.kind === 'in_pk');

  bLive.send('gift', { giftId: 'g_heart', quantity: 1, idempotencyKey: `release_check_${STAMP}_pk` });
  const pontuou = await waitFor('o placar mexer', () => bLive.state.pk.scoreA >= 20);
  check('o gift virou ponto no placar da batalha', pontuou, `placar=${bLive.state.pk.scoreA}`);

  await bLive.leave();
  const terminou = await waitFor('o PK terminar', () => aLive.state.pk.phase === 'FINISHED', 12_000);
  check('sair do palco encerra a batalha', terminou, `fase=${aLive.state.pk.phase}`);

  const gravou = await waitForApi('a batalha ser gravada', async () => {
    const { body } = await api('/me/pk', { headers: asUser(A.token) });
    return (body.matches ?? []).length > 0;
  }, 12_000);
  check('a API guardou a batalha que o servidor apurou', gravou);
  const historico = (await api('/me/pk', { headers: asUser(A.token) })).body.matches ?? [];
  check('e o vencedor gravado é o que o servidor declarou', historico[0]?.won === true,
    JSON.stringify(historico[0]));

  // ------------------------------------------------------------ fechamento ---
  step('10) Fechamento: a live acaba e a sessão continua renovável');
  aLive.send('endLive', {});
  const fechou = await waitFor('a live sair do feed', async () => {
    const { body } = await api('/lives');
    return !(body.lives ?? []).some((l) => l.hostId === A.userId);
  }, 12_000);
  check('encerrar a live fecha a sessão no banco', fechou);
  await aLive.leave().catch(() => {});

  const passosA = (await api('/me/onboarding', { headers: asUser(A.token) })).body;
  check('quem transmitiu completou "abrir live" na volta guiada',
    (passosA.steps ?? []).some((s) => s.step === 'open_live' && s.done), JSON.stringify(passosA.steps));

  const renovado = await api('/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken: A.refreshToken }),
  });
  check('a sessão se renova depois de tudo (senão o jogo cai em "offline" aos 15 min)',
    renovado.status === 200 && Boolean(renovado.body.token), `status=${renovado.status}`);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} verificações passaram.`);
  console.log(`   contas desta rodada: ${A.username} / ${B.username} (ficam no banco, por causa do extrato)`);
  for (const n of notes) console.log(`   · ${n}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 release check falhou:', err?.message ?? err);
  process.exit(1);
});
