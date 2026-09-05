import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Encoder } from '@colyseus/schema';
import { Client, type Room } from 'colyseus.js';
import { CityRoom } from '../src/rooms/CityRoom.js';
import { ApartmentState, CityState, LiveState } from '../src/rooms/schema.js';
import { CityInterest } from '../src/world/CityInterest.js';
import { presence } from '../src/world/Presence.js';
import type { AuthIdentity } from '../src/auth/AuthProvider.js';
import type { Client as ServerClient } from '@colyseus/core';
import type { PlayerState } from '../src/rooms/schema.js';
import { config } from '../src/config.js';
import { SCENES } from '../src/shared.js';

class InterestRoom extends CityRoom {
  protected override onPlayerJoined(client: ServerClient, identity: AuthIdentity, player: PlayerState): void {
    // A test-only, authoritative placement: never exposed as a client message.
    this.place(client.sessionId, identity.userId === 'far' ? 36 : 0, 0);
    super.onPlayerJoined(client, identity, player);
  }

  place(sessionId: string, x: number, z: number): void {
    this.sessions.get(sessionId)!.movement.place({ x, y: 0, z, yaw: 0, moving: false });
    const player = this.state.players.get(sessionId)!;
    player.x = x;
    player.z = z;
    this.onTick();
  }
}

const httpServer = http.createServer();
const server = new Server({ transport: new WebSocketTransport({ server: httpServer }), greet: false, gracefullyShutdown: false });
server.define('interest_test', InterestRoom);
server.define('interest_capacity', InterestRoom);
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
  const room = await new Client(endpoint).joinOrCreate<CityState>('interest_test', { token: userId });
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

it('filters only city bodies, never the apartment/live schema', () => {
  assert.equal(new Encoder(new CityState()).context.hasFilters, true);
  assert.equal(new Encoder(new ApartmentState()).context.hasFilters, false);
  assert.equal(new Encoder(new LiveState()).context.hasFilters, false);
  assert.throws(() => new CityInterest(0, 4));
  assert.throws(() => new CityInterest(24, 20));
});

it('ignores client-supplied capacity and keeps the operator/scene ceiling', async () => {
  for (const capacity of [100_000, 1, -1]) {
    const room = await new Client(endpoint).create<CityState>('interest_capacity', { token: `capacity_${capacity}`, capacity });
    room.onMessage('chatMessage', () => {});
    room.onMessage('correction', () => {});
    await until(() => !!room.state?.players?.has(room.sessionId), 'capacity test initial state');
    const actual = matchMaker.getLocalRoomById(room.roomId) as InterestRoom;
    assert.equal(actual.maxClients, Math.min(SCENES.central_plaza.capacity, config.cityCapacity));
    await room.leave();
  }
});

it('wire AOI preserves roster, chat, presence, re-entry, restyle, and duplicate-session cleanup', async () => {
  const near = await join('near');
  const far = await join('far');
  const actual = matchMaker.getLocalRoomById(near.roomId) as InterestRoom;
  assert.equal(far.roomId, near.roomId);
  await until(() => near.state.members.size === 2, 'global roster');
  assert.equal(near.state.players.size, 1, 'distant body absent from patches');
  assert.equal(far.state.players.size, 1, 'distant body absent from initial full state');
  assert.equal(actual.state.players.size, 2, 'server retains both authoritative bodies');
  assert.equal(presence().locationOf('far')?.roomId, near.roomId);

  const inbox: string[] = [];
  near.onMessage('chatMessage', (message: { text: string }) => inbox.push(message.text));
  far.send('chat', { text: 'Ainda estou na praça' });
  await until(() => inbox.includes('Ainda estou na praça'), 'chat from outside AOI');

  // Hidden state changes must appear in full on re-entry, including cosmetics.
  actual.state.players.get(far.sessionId)!.avatar.hair = 'updated-hair';
  actual.place(far.sessionId, 23, 0);
  await until(() => near.state.players.has(far.sessionId), 'enter radius');
  assert.equal(near.state.players.get(far.sessionId)!.avatar.hair, 'updated-hair');
  actual.state.members.get(far.sessionId)!.avatar.hair = 'old-roster-hair';
  far.send('restyle', { token: 'far' });
  await until(() => near.state.members.get(far.sessionId)?.avatar.hair !== 'old-roster-hair'
    && near.state.players.get(far.sessionId)?.avatar.hair !== 'updated-hair', 'authenticated restyle updates body and social roster');
  actual.place(far.sessionId, 26, 0);
  await delay(150);
  assert.equal(near.state.players.has(far.sessionId), true, 'hysteresis retains visible neighbor');
  actual.place(far.sessionId, 29, 0);
  await until(() => !near.state.players.has(far.sessionId), 'leave radius');
  assert.equal(near.state.members.size, 2, 'AOI leave does not remove social member');
  assert.equal(presence().locationOf('far')?.roomId, near.roomId, 'AOI leave is not disconnect');
  actual.place(far.sessionId, 26, 0);
  await delay(150);
  assert.equal(near.state.players.has(far.sessionId), false, 'outside enter radius stays hidden');
  actual.place(far.sessionId, 23, 0);
  await until(() => near.state.players.has(far.sessionId), 'second entry');

  const replacement = await join('far');
  await until(() => !near.state.members.has(far.sessionId) && near.state.members.has(replacement.sessionId), 'duplicate-tab replacement');
  assert.equal(actual.state.players.size, 2);
  assert.equal(near.state.players.has(far.sessionId), false, 'old visible body removed');
  assert.equal(presence().locationOf('far')?.roomId, near.roomId, 'old tab leave preserves replacement presence');

  await replacement.leave();
  await until(() => near.state.members.size === 1, 'disconnect removes roster');
  assert.equal(presence().locationOf('far'), undefined);
  assert.equal(actual.state.players.size, 1);
});
