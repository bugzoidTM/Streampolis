#!/usr/bin/env node
/**
 * End-to-end proof of SPECs §69 — the first technically valid build.
 *
 * Boots the real server in this process and drives it with real colyseus.js
 * clients over a real socket. Nothing here is mocked except the wallet, which
 * is the in-memory stub the game server uses when API_BASE_URL is unset.
 *
 *   npm run e2e --workspace @streampolis/game-server
 *
 * Run `npm run build` first (the npm script does it for you).
 */
import { Client } from 'colyseus.js';
import { FIXED_DT } from '../dist/shared/src/index.js';
import { gameServer, start, ROOM_CITY, ROOM_LIVE } from '../dist/game-server/src/index.js';

const PORT = Number(process.env.E2E_PORT ?? 2599);
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

let failures = 0;
let checks = 0;

function check(label, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function step(label) {
  console.log(`\n${label}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls a predicate instead of sleeping blindly; keeps the run fast and honest. */
async function waitFor(label, predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

/** Walks forward for `ticks` fixed steps, exactly as the client predictor does. */
async function walkForward(room, ticks) {
  for (let i = 1; i <= ticks; i++) {
    room.send('move', { dx: 0, dz: 1, yaw: 0, run: false, seq: i });
    await sleep(FIXED_DT * 1000);
  }
}

/** State only exists after the first patch; every read must tolerate that. */
function playersOf(room) {
  return room.state?.players ?? new Map();
}

async function waitForState(room, label) {
  const ok = await waitFor(`estado inicial de ${label}`, () => room.state?.players !== undefined);
  if (!ok) throw new Error(`sem estado inicial em ${label}`);
}

function findPlayer(room, userId) {
  for (const [, p] of playersOf(room)) if (p.id === userId) return p;
  return undefined;
}

async function main() {
  process.env.NODE_ENV = 'development';
  await start(PORT, '127.0.0.1');

  const ana = new Client(ENDPOINT);
  const beto = new Client(ENDPOINT);
  const caio = new Client(ENDPOINT);

  // ---------------------------------------------------------------- praça ---
  step('1) Praça: dois usuários reais, avatares visíveis');
  const anaCity = await ana.joinOrCreate(ROOM_CITY, { token: 'ana', sceneId: 'central_plaza' });
  const betoCity = await beto.joinOrCreate(ROOM_CITY, { token: 'beto', sceneId: 'central_plaza' });
  // Registrado já: a sala anuncia a chegada de cada um antes do primeiro patch.
  const betoInbox = [];
  betoCity.onMessage('chatMessage', (m) => betoInbox.push(m));
  anaCity.onMessage('chatMessage', () => {});
  await waitForState(anaCity, 'praça (Ana)');
  await waitForState(betoCity, 'praça (Beto)');

  check('as duas sessões caíram no mesmo shard', anaCity.roomId === betoCity.roomId);
  await waitFor('dois jogadores no estado', () => playersOf(betoCity).size === 2);
  check('Beto enxerga 2 avatares', playersOf(betoCity).size === 2, `viu ${playersOf(betoCity).size}`);

  const anaSeenByBeto = findPlayer(betoCity, 'ana');
  check('nome do jogador chega junto do avatar', Boolean(anaSeenByBeto?.name));
  check('cosmético veio no join', Boolean(anaSeenByBeto?.avatar?.top));

  // ----------------------------------------------------------- movimento ---
  step('2) Movimentação sincronizada e autoritativa');
  const startZ = anaSeenByBeto.z;
  await walkForward(anaCity, 12);
  const moved = await waitFor('a posição de Ana mudar para Beto', () => findPlayer(betoCity, 'ana').z > startZ + 0.2);
  check('o passo de Ana aparece no cliente de Beto', moved);

  const travelled = findPlayer(betoCity, 'ana').z - startZ;
  // 12 intents a 2.4 m/s no passo fixo: teto generoso, o servidor consome no
  // máximo 3 intents por tick e nunca deve andar mais que isso.
  check('o servidor não deixou andar mais do que a velocidade permite', travelled < 12 * 2.4 * FIXED_DT * 1.6,
    `andou ${travelled.toFixed(2)} m`);

  const teleportSeen = [];
  anaCity.onMessage('correction', (c) => teleportSeen.push(c));

  // Flood sustentado: 6 intents de corrida por tick durante 2 s. Rajadas curtas
  // são legítimas (a fila absorve jitter), então o que se verifica aqui é o
  // invariante que importa — deslocamento contra RELÓGIO, não contra ticks.
  const floodStartZ = findPlayer(betoCity, 'ana').z;
  const floodStartedAt = Date.now();
  let cheatSeq = 100000;
  for (let burst = 0; burst < 48; burst++) {
    for (let i = 0; i < 6; i++) anaCity.send('move', { dx: 0, dz: 1, yaw: 0, run: true, seq: cheatSeq++ });
    await sleep(FIXED_DT * 1000);
  }
  await sleep(300);
  const floodElapsed = (Date.now() - floodStartedAt) / 1000;
  // O teto tem três parcelas: o tempo real decorrido, uma janela de auditoria
  // (o crédito em voo que ainda não foi devolvido) e uma folga de latência —
  // medimos o relógio aqui e lemos um patch que o servidor produziu depois.
  const PATCH_LATENCY_S = 0.25;
  const cheatCeiling = 5.2 * 1.35 * (floodElapsed + 1 + PATCH_LATENCY_S + FIXED_DT);
  const cheated = findPlayer(betoCity, 'ana').z - floodStartZ;
  check('flood sustentado não passa do teto de velocidade', cheated <= cheatCeiling,
    `andou ${cheated.toFixed(2)} m em ${floodElapsed.toFixed(2)} s (teto ${cheatCeiling.toFixed(2)} m)`);
  check('o servidor avisou o cliente que corrigiu', teleportSeen.length > 0);

  // ---------------------------------------------------------------- chat ---
  step('3) Chat');
  anaCity.send('chat', { text: 'oi, Streampolis!' });
  await waitFor('mensagem chegar', () => betoInbox.some((m) => m.text === 'oi, Streampolis!'));
  check('Beto recebeu a mensagem de Ana', betoInbox.some((m) => m.text === 'oi, Streampolis!'));

  const beforeSpam = betoInbox.length;
  for (let i = 0; i < 12; i++) anaCity.send('chat', { text: `spam ${i}` });
  await sleep(500);
  check('rate limit cortou o spam', betoInbox.length - beforeSpam <= 5,
    `passaram ${betoInbox.length - beforeSpam}`);

  anaCity.send('chat', { text: 'que m3rrrda' });
  await sleep(300);
  const dirty = betoInbox.find((m) => m.text.includes('m3rrrda'));
  check('palavrão com leet não passa cru', dirty === undefined);

  await anaCity.leave();
  await betoCity.leave();

  // ---------------------------------------------------------------- live ---
  step('4) Go Live, espectador, gift e PK');
  const liveId = `live_e2e_${Date.now()}`;
  const anaLive = await ana.joinOrCreate(ROOM_LIVE, {
    token: 'ana', liveId, hostId: 'ana', hostName: 'Ana', title: 'Primeira live', category: 'música',
  });
  const caioLive = await caio.joinOrCreate(ROOM_LIVE, { token: 'caio', liveId, hostId: 'ana', role: 'cohost' });
  const betoLive = await beto.joinOrCreate(ROOM_LIVE, { token: 'beto', liveId, hostId: 'ana' });

  check('todos entraram na mesma live', anaLive.roomId === betoLive.roomId && caioLive.roomId === betoLive.roomId);
  await waitFor('palco com host e co-host', () => playersOf(betoLive).size === 2);
  check('só o palco tem avatar (host + co-host)', playersOf(betoLive).size === 2,
    `palco com ${playersOf(betoLive).size}`);
  await waitFor('contador de espectadores', () => betoLive.state.viewers === 1);
  check('espectador conta como audiência, não como avatar', betoLive.state.viewers === 1);

  const anaEmoted = [];
  anaLive.onMessage('notice', (n) => anaEmoted.push(n));
  anaLive.send('emote', { anim: 'dance' });
  await waitFor('animação do host', () => findPlayer(betoLive, 'ana')?.anim === 'dance');
  check('streamer executa animação e todos veem', findPlayer(betoLive, 'ana')?.anim === 'dance');

  const giftsAtBeto = [];
  const giftsAtAna = [];
  betoLive.onMessage('giftEvent', (g) => giftsAtBeto.push(g));
  anaLive.onMessage('giftEvent', (g) => giftsAtAna.push(g));

  betoLive.send('gift', { giftId: 'g_rose', quantity: 3, idempotencyKey: 'e2e_gift_1' });
  await waitFor('gift aparecer', () => giftsAtBeto.length > 0 && giftsAtAna.length > 0);
  check('gift aparece nos dois navegadores', giftsAtBeto.length === 1 && giftsAtAna.length === 1);
  check('gift foi para o host', giftsAtAna[0]?.receiverId === 'ana');

  // A mesma chave reenviada: cobrança única, portanto evento único.
  betoLive.send('gift', { giftId: 'g_rose', quantity: 3, idempotencyKey: 'e2e_gift_1' });
  await sleep(500);
  check('reenvio com a mesma chave não duplica o evento', giftsAtBeto.length === 1,
    `chegaram ${giftsAtBeto.length}`);

  const noticesAtBeto = [];
  betoLive.onMessage('notice', (n) => noticesAtBeto.push(n));
  betoLive.send('gift', { giftId: 'g_inexistente', quantity: 1, idempotencyKey: 'e2e_gift_2' });
  await waitFor('recusa de presente inválido', () => noticesAtBeto.some((n) => n.code.startsWith('gift_')));
  check('presente inválido é recusado sem evento', giftsAtBeto.length === 1);

  betoLive.send('like', { count: 5 });
  await waitFor('likes agregados', () => betoLive.state.likes >= 5);
  check('likes chegam agregados, não um a um', betoLive.state.likes >= 5);

  // ------------------------------------------------------------------ PK ---
  step('5) PK entre dois avatares');
  anaLive.send('startPK', { opponentId: 'caio' });
  await waitFor('PK em contagem', () => betoLive.state.pk.phase === 'COUNTDOWN');
  check('PK começa em COUNTDOWN pelo relógio do servidor', betoLive.state.pk.phase === 'COUNTDOWN');

  await waitFor('PK ativo', () => betoLive.state.pk.phase === 'ACTIVE', 8_000);
  check('PK entra em ACTIVE sozinho', betoLive.state.pk.phase === 'ACTIVE');

  betoLive.send('gift', { giftId: 'g_star', quantity: 1, idempotencyKey: 'e2e_pk_1' });
  await waitFor('placar do host subir', () => betoLive.state.pk.scoreA >= 99);
  check('gift validado vira ponto de PK do lado certo', betoLive.state.pk.scoreA >= 99 && betoLive.state.pk.scoreB === 0,
    `A=${betoLive.state.pk.scoreA} B=${betoLive.state.pk.scoreB}`);

  betoLive.send('gift', { giftId: 'g_heart', quantity: 2, idempotencyKey: 'e2e_pk_2', receiverId: 'caio' });
  await waitFor('placar do co-host subir', () => betoLive.state.pk.scoreB >= 40);
  check('gift para o co-host pontua para o outro lado', betoLive.state.pk.scoreB >= 40);

  const pkResults = [];
  betoLive.onMessage('pkResult', (r) => pkResults.push(r));
  await caioLive.leave();
  await waitFor('PK encerrado com a saída do co-host', () => pkResults.length > 0);
  check('sair do PK encerra a batalha com resultado do servidor', pkResults.length === 1);
  check('vencedor é quem tinha mais pontos', pkResults[0]?.winnerId === 'ana', JSON.stringify(pkResults[0] ?? {}));

  // ------------------------------------------------------------- encerra ---
  step('6) Encerrar a live');
  const endNotices = [];
  betoLive.onMessage('notice', (n) => endNotices.push(n));
  anaLive.send('endLive', {});
  await waitFor('aviso de fim', () => endNotices.some((n) => n.code === 'live_ended'));
  check('espectador é avisado do fim da live', endNotices.some((n) => n.code === 'live_ended'));

  await sleep(2_000);
  await gameServer.gracefullyShutdown(false);

  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} verificações passaram.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n💥 e2e falhou:', err);
  try { await gameServer.gracefullyShutdown(false); } catch { /* já caiu */ }
  process.exit(1);
});
