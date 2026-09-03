#!/usr/bin/env node
/**
 * Prova de sharding da praça (SPECs §17).
 *
 * A regra é: quando `central_plaza` lota, o matchmaker abre OUTRA praça em vez
 * de degradar a primeira. Isso já está no código (capacidade real em
 * `maxClients` + `filterBy(['sceneId'])` + `joinOrCreate` no cliente), mas até
 * agora nada provava — o e2e principal roda com 2 jogadores e 36 vagas, ou
 * seja, nunca chega perto do limite onde o comportamento aparece.
 *
 * Aqui a capacidade cai para 2 e entram 5 jogadores reais, por socket real.
 * O que se verifica não é "existem 3 salas", é o conjunto de invariantes que
 * torna o sharding utilizável:
 *
 *   1. nenhum shard passa da lotação;
 *   2. quem sobra abre shard novo em vez de tomar erro;
 *   3. o shard cheio fica trancado (locked) e sai do sorteio;
 *   4. cada jogador só enxerga os vizinhos DO SEU shard — é isto que faz do
 *      shard uma sala e não uma etiqueta;
 *   5. o filtro é por cena: pedir a loja nunca cai numa praça com vaga;
 *   6. vaga que se abre é reaproveitada — a lotação é um teto vivo, não um
 *      corte feito uma vez.
 *
 * Esta tarefa NÃO altera a lógica de matchmaking. Só a observa.
 *
 *   npm run e2e:shard --workspace @streampolis/game-server
 */

// A capacidade é lida na carga do config.js, então tem de estar no ambiente
// ANTES do import dinâmico lá embaixo.
process.env.CITY_CAPACITY = process.env.CITY_CAPACITY ?? '2';
process.env.NODE_ENV = 'development';

import { Client } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';

const CAPACITY = Number(process.env.CITY_CAPACITY);
const PORT = Number(process.env.E2E_SHARD_PORT ?? 2597);
const ENDPOINT = `ws://127.0.0.1:${PORT}`;
const PLAYERS = 5;

const { gameServer, start, ROOM_CITY } = await import('../dist/game-server/src/index.js');

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (label) => console.log(`\n${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(25);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

/** O estado só existe depois do primeiro patch; toda leitura tolera isso. */
async function waitForState(room, label) {
  const ok = await waitFor(`estado inicial de ${label}`, () => room.state?.players !== undefined);
  if (!ok) throw new Error(`sem estado inicial em ${label}`);
  return room;
}

/** Sala da praça vista pelo matchmaker, incluindo as trancadas. */
async function cityRooms(sceneId) {
  const rooms = await matchMaker.query({ name: ROOM_CITY });
  return rooms.filter((r) => !sceneId || r.metadata?.sceneId === sceneId);
}

async function main() {
  await start(PORT, '127.0.0.1');
  console.log(`praça com lotação ${CAPACITY}, ${PLAYERS} jogadores entrando um a um`);

  // --------------------------------------------------------------- lotação ---
  step('1) Cinco jogadores, praça de duas vagas');
  const joined = [];
  // Registrado antes do primeiro patch: a sala anuncia cada chegada no chat,
  // então quem entra depois já tem de estar ouvindo.
  const inbox = new Map();
  for (let i = 1; i <= PLAYERS; i++) {
    const client = new Client(ENDPOINT);
    // joinOrCreate é exatamente o que o cliente do jogo chama: o jogador pede
    // a CENA, nunca um shard. Quem escolhe o shard é o servidor.
    const room = await client.joinOrCreate(ROOM_CITY, { token: `p${i}`, sceneId: 'central_plaza' });
    inbox.set(`p${i}`, []);
    room.onMessage('chatMessage', (m) => inbox.get(`p${i}`).push(m));
    await waitForState(room, `p${i}`);
    joined.push({ id: `p${i}`, client, room });
  }

  const byShard = new Map();
  for (const p of joined) {
    if (!byShard.has(p.room.roomId)) byShard.set(p.room.roomId, []);
    byShard.get(p.room.roomId).push(p.id);
  }
  const occupancy = [...byShard.values()].map((ids) => ids.length).sort((a, b) => b - a);
  const expectedShards = Math.ceil(PLAYERS / CAPACITY);

  for (const [roomId, ids] of byShard) console.log(`     ${roomId}: ${ids.join(', ')}`);

  check(`${PLAYERS} jogadores viraram ${expectedShards} shards`, byShard.size === expectedShards,
    `foram ${byShard.size}`);
  check('nenhum shard passou da lotação', occupancy.every((n) => n <= CAPACITY),
    `ocupação ${occupancy.join('/')}`);
  check('o último a entrar não tomou erro de sala cheia', joined.length === PLAYERS);
  check('os shards encheram na ordem, sem espalhar', occupancy.join('/') === '2/2/1',
    `ocupação ${occupancy.join('/')}`);

  // ------------------------------------------------------- o que cada um vê ---
  step('2) Um shard é uma sala, não uma etiqueta');
  for (const p of joined) {
    const expected = byShard.get(p.room.roomId).length;
    await waitFor(`${p.id} enxergar ${expected}`, () => p.room.state.players.size === expected);
  }
  const visionOk = joined.every((p) => p.room.state.players.size === byShard.get(p.room.roomId).length);
  check('cada jogador só enxerga quem está no seu shard', visionOk,
    joined.map((p) => `${p.id}=${p.room.state.players.size}`).join(' '));
  check('o estado carrega a identidade do shard', joined.every((p) => p.room.state.shard === p.room.roomId));
  check('todos os shards são da mesma cena', joined.every((p) => p.room.state.sceneId === 'central_plaza'));

  // Chat é o teste social do isolamento: se vazasse entre shards, dois grupos
  // que nunca se veem estariam conversando.
  const [first] = joined;
  first.room.send('chat', { text: 'eco de shard' });
  await sleep(400);
  const heard = joined.filter((p) => inbox.get(p.id).some((m) => m.text === 'eco de shard')).map((p) => p.id);
  const sameShard = byShard.get(first.room.roomId);
  check('a fala fica dentro do shard', heard.length === sameShard.length && heard.every((id) => sameShard.includes(id)),
    `ouviram: ${heard.join(', ') || 'ninguém'}`);

  // -------------------------------------------------------------- trancado ---
  step('3) Shard cheio sai do sorteio');
  const plazas = await cityRooms('central_plaza');
  check('o matchmaker conhece os três shards', plazas.length === expectedShards, `viu ${plazas.length}`);
  const full = plazas.filter((r) => r.clients >= CAPACITY);
  check('os shards cheios estão trancados', full.length === 2 && full.every((r) => r.locked === true),
    full.map((r) => `${r.roomId}:${r.clients}${r.locked ? ' locked' : ''}`).join(' '));
  const open = plazas.filter((r) => r.locked !== true);
  check('sobra exatamente um shard aberto', open.length === 1, `abertos ${open.length}`);

  // ------------------------------------------------------------ outra cena ---
  step('4) O filtro é por cena, não só por lotação');
  const shopper = new Client(ENDPOINT);
  const shopRoom = await shopper.joinOrCreate(ROOM_CITY, { token: 'p9', sceneId: 'stream_store' });
  shopRoom.onMessage('chatMessage', () => {});
  await waitForState(shopRoom, 'p9');
  check('quem pede a loja não cai numa praça com vaga', !byShard.has(shopRoom.roomId));
  check('a loja é uma sala de loja', shopRoom.state.sceneId === 'stream_store', shopRoom.state.sceneId);
  check('a praça continua com três shards', (await cityRooms('central_plaza')).length === expectedShards);

  // ------------------------------------------------------------ vaga volta ---
  step('5) Lotação é teto vivo: vaga que abre é reaproveitada');
  const leaver = joined.find((p) => byShard.get(p.room.roomId).length === CAPACITY);
  const freedShard = leaver.room.roomId;
  await leaver.room.leave();
  const unlocked = await waitFor('o shard destrancar', async () =>
    (await cityRooms('central_plaza')).some((r) => r.roomId === freedShard && r.locked !== true));
  check('sair de um shard cheio o destranca', unlocked);

  const latecomer = new Client(ENDPOINT);
  const lateRoom = await latecomer.joinOrCreate(ROOM_CITY, { token: 'p10', sceneId: 'central_plaza' });
  lateRoom.onMessage('chatMessage', () => {});
  await waitForState(lateRoom, 'p10');
  check('o próximo jogador ocupa a vaga em vez de abrir shard novo',
    (await cityRooms('central_plaza')).length === expectedShards,
    `agora há ${(await cityRooms('central_plaza')).length} shards (entrou em ${lateRoom.roomId})`);

  // ------------------------------------------------------------- encerra ---
  await sleep(200);
  await gameServer.gracefullyShutdown(false);
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} verificações passaram.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n💥 e2e de sharding falhou:', err);
  try { await gameServer.gracefullyShutdown(false); } catch { /* já caiu */ }
  process.exit(1);
});
