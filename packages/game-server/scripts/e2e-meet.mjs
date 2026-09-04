#!/usr/bin/env node
/**
 * Prova do "Encontrar" (PRD §20, SPECs §17).
 *
 * O botão promete uma coisa específica: entrar na MESMA sala onde o amigo está,
 * e não numa praça idêntica com o mesmo nome. Num mundo shardado essas duas
 * coisas são indistinguíveis na tela — as duas praças têm o mesmo cenário, o
 * mesmo chão e o mesmo nome —, e a única diferença observável é se a pessoa
 * está lá dentro. Por isso este arquivo existe: sem ele, "Encontrar" quebrado e
 * "Encontrar" funcionando têm exatamente a mesma aparência.
 *
 * O que se verifica:
 *
 *   1. `joinById` no shard do amigo entra NAQUELE shard, e os dois se veem;
 *   2. shard cheio RECUSA o assento — é o que torna a vaga uma condição real e
 *      não um detalhe de implementação;
 *   3. a queda para o matchmaking normal da mesma cena continua funcionando, e
 *      o jogador percebe que caiu em outra sala (roomId diferente do pedido);
 *   4. vaga que abre volta a aceitar o encontro.
 *
 * Nada de matchmaking é alterado aqui: o caminho novo é `joinById`, que só
 * encontra sala existente.
 *
 *   npm run e2e:meet --workspace @streampolis/game-server
 */

process.env.CITY_CAPACITY = process.env.CITY_CAPACITY ?? '2';
process.env.NODE_ENV = 'development';

import { Client } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';

const CAPACITY = Number(process.env.CITY_CAPACITY);
const PORT = Number(process.env.E2E_MEET_PORT ?? 2598);
const ENDPOINT = `ws://127.0.0.1:${PORT}`;

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

async function entrar(token, sceneId = 'central_plaza') {
  const client = new Client(ENDPOINT);
  const room = await client.joinOrCreate(ROOM_CITY, { token, sceneId });
  room.onMessage('chatMessage', () => {});
  await waitFor(`estado inicial de ${token}`, () => room.state?.players !== undefined);
  return { token, client, room };
}

/**
 * O que o cliente do jogo faz quando alguém clica em "Encontrar": tenta o
 * shard exato e, se ele recusar, cai no matchmaking normal DA MESMA CENA.
 * Réplica fiel de `meetAt` em `client/src/network/session.ts`.
 */
async function encontrar(token, roomId, sceneId = 'central_plaza') {
  const client = new Client(ENDPOINT);
  let room;
  let caiu = false;
  try {
    room = await client.joinById(roomId, { token });
  } catch {
    caiu = true;
    room = await client.joinOrCreate(ROOM_CITY, { token, sceneId });
  }
  room.onMessage('chatMessage', () => {});
  await waitFor(`estado inicial de ${token}`, () => room.state?.players !== undefined);
  return { token, client, room, caiu };
}

async function plazas() {
  const rooms = await matchMaker.query({ name: ROOM_CITY });
  return rooms.filter((r) => r.metadata?.sceneId === 'central_plaza');
}

async function main() {
  await start(PORT, '127.0.0.1');
  console.log(`praça com lotação ${CAPACITY}`);

  // ------------------------------------------------------- encontro simples ---
  step('1) Encontrar entra no shard do amigo');
  const ana = await entrar('ana');
  const beto = await encontrar('beto', ana.room.roomId);

  check('a entrada não caiu no matchmaking', beto.caiu === false);
  check('os dois estão na MESMA sala', beto.room.roomId === ana.room.roomId,
    `${beto.room.roomId} vs ${ana.room.roomId}`);
  await waitFor('ana enxergar duas pessoas', () => ana.room.state.players.size === 2);
  check('e um vê o outro lá dentro', ana.room.state.players.size === 2,
    `ana vê ${ana.room.state.players.size}`);

  // --------------------------------------------------------- shard lotado ---
  step('2) Sem vaga, o shard recusa — e a queda é para a mesma cena');
  const lotado = ana.room.roomId;
  const trancou = await waitFor('o shard trancar',
    async () => (await plazas()).some((r) => r.roomId === lotado && r.locked === true));
  check('shard cheio fica trancado', trancou);

  const carla = await encontrar('carla', lotado);
  check('quem não coube caiu no matchmaking normal', carla.caiu === true);
  check('e foi parar em OUTRA sala', carla.room.roomId !== lotado,
    `entrou em ${carla.room.roomId}`);
  check('mas na mesma cena', carla.room.state.sceneId === 'central_plaza', carla.room.state.sceneId);
  // É esta diferença que a interface compara para avisar "a sala do seu amigo
  // estava cheia" em vez de deixar o jogador numa praça vazia sem explicação.
  check('o cliente consegue perceber a troca comparando o roomId',
    carla.room.roomId !== lotado);

  // ---------------------------------------------------------- vaga de volta ---
  step('3) Vaga que abre volta a aceitar o encontro');
  await beto.room.leave();
  const destrancou = await waitFor('o shard destrancar',
    async () => (await plazas()).some((r) => r.roomId === lotado && r.locked !== true));
  check('sair destranca o shard', destrancou);

  const dani = await encontrar('dani', lotado);
  check('agora o encontro acontece', dani.caiu === false && dani.room.roomId === lotado,
    `caiu=${dani.caiu} sala=${dani.room.roomId}`);
  await waitFor('ana enxergar dani', () => ana.room.state.players.size === 2);
  check('e ana vê quem chegou', ana.room.state.players.size === 2,
    `ana vê ${ana.room.state.players.size}`);

  // ------------------------------------------------------ sala inexistente ---
  step('4) Sala que não existe não é criada por engano');
  const antes = (await plazas()).length;
  const fantasma = await encontrar('edu', 'sala_que_nunca_existiu');
  check('joinById não cria sala', fantasma.caiu === true);
  check('a queda usou o matchmaking normal, sem inventar shard',
    (await plazas()).length <= antes + 1);

  await sleep(200);
  await gameServer.gracefullyShutdown(false);
  console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} verificações passaram.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n💥 e2e de encontro falhou:', err);
  try { await gameServer.gracefullyShutdown(false); } catch { /* já caiu */ }
  process.exit(1);
});
