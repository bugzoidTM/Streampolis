import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client, type Room } from 'colyseus.js';
import { CityRoom } from '../src/rooms/CityRoom.js';
import type { CityState } from '../src/rooms/schema.js';
import { presence } from '../src/world/Presence.js';
import { AuthError, type AuthIdentity, type AuthProvider } from '../src/auth/AuthProvider.js';
import { DEFAULT_AVATAR } from '../src/shared.js';

/**
 * Lotação é de PESSOAS (PRD §25 + SPECs §17).
 *
 * Um personagem da cidade entra na sala como qualquer cliente, mas não é
 * público: trinta deles na praça não podem deixar seis cadeiras para gente de
 * verdade nem empurrar o próximo jogador para um shard vazio. O que se prova
 * aqui é a tranca do matchmaking contando só humanos — inclusive depois de um
 * personagem sair de uma sala cheia, que é quando o Colyseus destrancaria por
 * conta própria.
 */

/** `npc:<id>` entra com a permissão de personagem; o resto é gente. */
class NpcAwareAuth implements AuthProvider {
  async authenticate(token: string): Promise<AuthIdentity> {
    const userId = (token || '').trim();
    if (!userId) throw new AuthError('missing_token', 'Token ausente');
    const npc = userId.startsWith('npc:');
    return {
      userId, displayName: userId, permissions: npc ? ['play', 'npc'] : ['play'],
      gifterLevel: 0, agency: '', sessionId: `${userId}:t`, avatar: { ...DEFAULT_AVATAR },
    };
  }
}

const HUMANS = 2;
const HEADROOM = 4;

class SmallRoom extends CityRoom {
  protected override readonly auth: AuthProvider = new NpcAwareAuth();
  override onCreate(options = {}): void {
    super.onCreate(options);
    this.humanCapacity = HUMANS;
    this.maxClients = HUMANS + HEADROOM;
  }
}

const httpServer = http.createServer();
const server = new Server({ transport: new WebSocketTransport({ server: httpServer }), greet: false, gracefullyShutdown: false });
server.define('npc_capacity', SmallRoom);
let endpoint = '';

async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 4_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail(`Timed out: ${label}`);
}

async function join(userId: string): Promise<Room<CityState>> {
  const room = await new Client(endpoint).joinOrCreate<CityState>('npc_capacity', { token: userId });
  room.onMessage('chatMessage', () => {});
  room.onMessage('notice', () => {});
  room.onMessage('correction', () => {});
  await until(() => !!room.state?.players?.get(room.sessionId), `${userId} initial self state`);
  return room;
}

before(async () => {
  await server.listen(0, '127.0.0.1');
  endpoint = `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});

after(async () => {
  await server.gracefullyShutdown(false);
  presence().stop();
});

it('personagens não ocupam vaga de gente, e a sala cheia de gente continua trancada quando um personagem sai', async () => {
  const npcA = await join('npc:a');
  const npcB = await join('npc:b');
  const npcC = await join('npc:c');
  const ana = await join('ana');
  // Três personagens e uma pessoa numa sala de lotação 2: ainda cabe gente.
  assert.equal(ana.roomId, npcA.roomId);
  assert.equal(npcC.roomId, npcA.roomId);
  const room = matchMaker.getLocalRoomById(ana.roomId) as SmallRoom;
  assert.equal(room.locked, false, 'com uma pessoa a sala está aberta');

  const beto = await join('beto');
  assert.equal(beto.roomId, ana.roomId, 'a segunda pessoa ainda entra');
  await until(() => room.locked, 'duas pessoas trancam a sala');

  // A terceira pessoa ganha um shard novo — não é recusada.
  const caio = await join('caio');
  assert.notEqual(caio.roomId, ana.roomId);

  // Um personagem sai: o Colyseus destrancaria; a sala tem de continuar cheia de gente.
  await npcC.leave();
  await delay(250);
  assert.equal(room.locked, true, 'personagem saindo não abre vaga de gente');
  assert.equal(room.hasReachedMaxClients(), true);

  // Uma pessoa sai: aí sim abre, e a próxima cai na MESMA sala.
  await beto.leave();
  await until(() => !room.locked, 'pessoa saindo destranca');
  const dora = await join('dora');
  assert.equal(dora.roomId, ana.roomId);

  await Promise.all([npcA.leave(), npcB.leave(), ana.leave(), caio.leave(), dora.leave()]);
});

it('o teto físico (lotação + folga) continua valendo para personagens', async () => {
  const bodies: Room<CityState>[] = [];
  for (let i = 0; i < HUMANS + HEADROOM; i++) bodies.push(await join(`npc:${i}`));
  const first = bodies[0]!.roomId;
  assert.ok(bodies.every((b) => b.roomId === first), 'todos couberam na mesma sala');
  const extra = await join('npc:extra');
  assert.notEqual(extra.roomId, first, 'acima do teto físico o próximo vai para outra sala');
  await Promise.all([...bodies, extra].map((b) => b.leave()));
});

it('o relógio do mundo chega no estado da sala, dentro do dia, com a taxa configurada', async () => {
  const { worldClockRate, worldMinutesAt } = await import('../src/shared.js');
  const { config } = await import('../src/config.js');
  const ana = await join('relogio');
  // O default do schema já é um número: espera a PRIMEIRA escrita da sala (tick a andar e clock a mexer).
  await until(() => ana.state.tick >= 24 && ana.state.clock > 0, 'relógio no estado');
  assert.ok(ana.state.clock >= 0 && ana.state.clock < 1440);
  assert.equal(ana.state.clockRate, worldClockRate(config.worldDayMinutes));
  // O que a sala escreveu é o que a fórmula compartilhada dá para agora (com folga de escrita).
  const expected = worldMinutesAt(Date.now(), config.worldDayMinutes);
  const diff = Math.abs(((expected - ana.state.clock) % 1440 + 1440) % 1440);
  assert.ok(Math.min(diff, 1440 - diff) < worldClockRate(config.worldDayMinutes) * 0.1, `desvio ${diff} min`);
  await ana.leave();
});

it('o clima do mundo chega no estado e é o que a fórmula compartilhada (ou o operador) escolhe', async () => {
  const { weatherAt, weatherOfSlot, isWeather } = await import('../src/shared.js');
  const { config } = await import('../src/config.js');
  const ana = await join('clima');
  await until(() => ana.state.tick >= 24 && ana.state.clock > 0, 'primeira escrita');
  assert.ok(isWeather(ana.state.weather));
  assert.equal(ana.state.weather, weatherAt(Date.now(), config.worldDayMinutes, config.worldWeather));
  // O sorteio por janela é determinístico e tem os dois lados.
  const slots = Array.from({ length: 200 }, (_, i) => weatherOfSlot(i));
  assert.ok(slots.includes('rain') && slots.includes('clear'));
  assert.deepEqual(slots, Array.from({ length: 200 }, (_, i) => weatherOfSlot(i)));
  assert.equal(weatherAt(0, 120, 'rain'), 'rain');
  await ana.leave();
});
