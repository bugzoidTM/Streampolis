#!/usr/bin/env node
/**
 * Integração real: game server + API + Postgres, sem nenhum stub.
 *
 * O e2e principal roda com a economia em memória, o que prova a ORDEM dos
 * eventos mas não prova que os dois pacotes concordam sobre o contrato. Aqui a
 * moeda sai de uma carteira de verdade, o token é assinado pela API de verdade
 * e o resultado do PK vira linha no banco.
 *
 * Pré-requisitos:
 *   packages/api: npm run migrate && npm run seed && npm run dev
 *
 *   npm run e2e:api --workspace @streampolis/game-server
 */
import { Client } from 'colyseus.js';

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
const SECRET = process.env.JWT_SECRET ?? 'dev-only-access-secret-change-me';
const SERVICE = process.env.API_SERVICE_TOKEN ?? 'dev-only-service-token';
const PORT = Number(process.env.E2E_API_PORT ?? 2598);

// O game server precisa das mesmas credenciais ANTES de importar config.js.
process.env.AUTH_JWT_SECRET = SECRET;
process.env.API_BASE_URL = API;
process.env.API_SERVICE_TOKEN = SERVICE;

const { gameServer, start, ROOM_CITY, ROOM_LIVE } = await import('../dist/game-server/src/index.js');

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (label) => console.log(`\n${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(50);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const asUser = (token) => ({ authorization: `Bearer ${token}` });

async function login(username) {
  const { status, body } = await api('/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  if (status !== 200) throw new Error(`login de ${username} falhou (${status}): ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const health = await api('/health');
  if (health.status !== 200) {
    console.error(`API não respondeu em ${API}. Suba packages/api antes.`);
    process.exit(2);
  }

  await start(PORT, '127.0.0.1');
  const endpoint = `ws://127.0.0.1:${PORT}`;

  // ------------------------------------------------------------- sessão ---
  step('1) Token assinado pela API vale no game server');
  const ana = await login('ana');
  const beto = await login('beto');
  const caio = await login('caio');

  const anaClient = new Client(endpoint);
  const betoClient = new Client(endpoint);
  const caioClient = new Client(endpoint);

  const anaCity = await anaClient.joinOrCreate(ROOM_CITY, {
    token: ana.token,
    sceneId: 'central_plaza',
    // Tentativa de vestir item pago pelo join: tem que ser ignorada.
    avatar: { top: 'top_holo_01', accessory: 'acc_halo_01' },
  });
  await waitFor('estado inicial', () => anaCity.state?.players !== undefined);
  const anaPlayer = [...anaCity.state.players.values()].find((p) => p.id === ana.identity.userId);
  check('entrou autenticado pelo JWT da API', Boolean(anaPlayer), 'jogador não apareceu no estado');
  check('nome vem da API', anaPlayer?.name === ana.identity.displayName, `name=${anaPlayer?.name}`);
  check('aparência é a assinada, não a pedida no join',
    anaPlayer?.avatar?.top === ana.identity.avatar.top && anaPlayer?.avatar?.accessory === '',
    `top=${anaPlayer?.avatar?.top} accessory=${anaPlayer?.avatar?.accessory}`);

  step('2) Token forjado não entra');
  let refused = false;
  try {
    const forged = `${ana.token.slice(0, -4)}AAAA`;
    await betoClient.joinOrCreate(ROOM_CITY, { token: forged, sceneId: 'central_plaza' });
  } catch {
    refused = true;
  }
  check('assinatura inválida é recusada', refused);
  await anaCity.leave();

  // --------------------------------------------------------------- gift ---
  step('3) Gift debita carteira de verdade');
  const walletBefore = (await api('/me/wallet', { headers: asUser(beto.token) })).body;

  const anaLive = await anaClient.create(ROOM_LIVE, {
    token: ana.token, title: 'Live com API', category: 'música',
  });
  await waitFor('estado da live', () => anaLive.state?.liveId !== undefined);
  const betoLive = await betoClient.joinById(anaLive.roomId, { token: beto.token });
  const caioLive = await caioClient.joinById(anaLive.roomId, { token: caio.token });
  await waitFor('espectadores', () => betoLive.state?.viewers >= 1);

  const gifts = [];
  betoLive.onMessage('giftEvent', (g) => gifts.push(g));
  betoLive.onMessage('notice', () => {});
  betoLive.onMessage('chatMessage', () => {});
  anaLive.onMessage('chatMessage', () => {});
  caioLive.onMessage('chatMessage', () => {});
  caioLive.onMessage('notice', () => {});

  const key = `e2e_api_${Date.now()}`;
  betoLive.send('gift', { giftId: 'g_star', quantity: 2, idempotencyKey: key });
  await waitFor('gift transmitido', () => gifts.length > 0);
  check('gift chegou aos espectadores', gifts.length === 1);

  const walletAfter = (await api('/me/wallet', { headers: asUser(beto.token) })).body;
  check('a carteira foi debitada pelo preço do catálogo',
    walletBefore.coins - walletAfter.coins === 198,
    `${walletBefore.coins} → ${walletAfter.coins}`);

  // Mesma chave de novo: a API já liquidou, então não pode haver segundo débito.
  betoLive.send('gift', { giftId: 'g_star', quantity: 2, idempotencyKey: key });
  await sleep(800);
  const walletReplay = (await api('/me/wallet', { headers: asUser(beto.token) })).body;
  check('reenvio com a mesma chave não cobra de novo', walletReplay.coins === walletAfter.coins,
    `${walletAfter.coins} → ${walletReplay.coins}`);
  check('reenvio também não duplica o evento', gifts.length === 1, `${gifts.length} eventos`);

  const ledger = (await api('/me/ledger?limit=5', { headers: asUser(beto.token) })).body;
  check('o débito virou uma linha de ledger', ledger.entries?.[0]?.amount === -198,
    JSON.stringify(ledger.entries?.[0]?.amount));

  step('4) Saldo insuficiente não gera evento');
  const caioWallet = (await api('/me/wallet', { headers: asUser(caio.token) })).body;
  const caioNotices = [];
  caioLive.onMessage('notice', (n) => caioNotices.push(n));
  caioLive.send('gift', { giftId: 'g_rocket', quantity: 1, idempotencyKey: `e2e_broke_${Date.now()}` });
  await waitFor('recusa por saldo', () => caioNotices.some((n) => n.code === 'gift_insufficient_funds'));
  check('gift caro é recusado', caioNotices.some((n) => n.code === 'gift_insufficient_funds'),
    `saldo do caio: ${caioWallet.coins}`);
  check('recusa não transmitiu evento', gifts.length === 1);

  // ----------------------------------------------------------------- PK ---
  step('5) Resultado do PK é gravado pela API');
  anaLive.send('invite', { userId: caio.identity.userId });
  await sleep(400);
  caioLive.send('acceptStage', {});
  await waitFor('co-host no palco', () => anaLive.state.players.size === 2);

  anaLive.send('startPK', { opponentId: caio.identity.userId });
  await waitFor('PK ativo', () => betoLive.state.pk.phase === 'ACTIVE', 10_000);
  betoLive.send('gift', { giftId: 'g_heart', quantity: 1, idempotencyKey: `e2e_pk_${Date.now()}` });
  await waitFor('placar do host', () => betoLive.state.pk.scoreA >= 20);

  await caioLive.leave();
  await waitFor('PK encerrado', () => betoLive.state.pk.phase === 'FINISHED');

  const persisted = await waitFor('histórico de PK gravado', async () => {
    const { body } = await api('/me/pk', { headers: asUser(ana.token) });
    return (body.matches ?? []).length > 0;
  }, 8_000);
  check('a API guardou a batalha que o servidor apurou', persisted);

  const history = (await api('/me/pk', { headers: asUser(ana.token) })).body.matches ?? [];
  check('vencedor gravado é o que o servidor declarou', history[0]?.won === true,
    JSON.stringify(history[0]));

  step('6) Live aparece no feed da API e fecha ao terminar');
  const listed = (await api('/lives')).body.lives ?? [];
  check('a live foi registrada na API', listed.some((l) => l.hostId === ana.identity.userId),
    `${listed.length} lives listadas`);

  anaLive.send('endLive', {});
  const closed = await waitFor('live encerrada na API', async () => {
    const { body } = await api('/lives');
    return !(body.lives ?? []).some((l) => l.hostId === ana.identity.userId);
  }, 8_000);
  check('encerrar a live fecha a sessão no banco', closed);

  await sleep(1_500);
  await gameServer.gracefullyShutdown(false);
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} verificações passaram.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n💥 e2e com API falhou:', err);
  try { await gameServer.gracefullyShutdown(false); } catch { /* já caiu */ }
  process.exit(1);
});
