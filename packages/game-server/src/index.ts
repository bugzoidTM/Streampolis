import http from 'node:http';
import { matchMaker, Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { config, isProduction } from './config.js';
import { CityRoom } from './rooms/CityRoom.js';
import { ApartmentRoom } from './rooms/ApartmentRoom.js';
import { LiveRoom } from './rooms/LiveRoom.js';
import type { LiveSummary } from './shared.js';

/**
 * Game server process (SPECs §52, §54).
 *
 * This process synchronises world and events. It holds no permanent data and
 * settles no money — packages/api owns both. Restarting it must cost players
 * nothing but a reconnect.
 */

export const ROOM_CITY = 'city';
export const ROOM_APARTMENT = 'apartment';
export const ROOM_LIVE = 'live';

const httpServer = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/health' || url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime(), env: config.env }));
    return;
  }
  if (url.startsWith('/live')) {
    // PoC-only feed source. TODO(api agent): once /lives exists in the API,
    // this stays as a debug endpoint and the client stops reading it.
    listLives()
      .then((lives) => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(JSON.stringify(lives));
      })
      .catch(() => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'listing_failed' }));
      });
    return;
  }
  res.writeHead(404).end();
});

async function listLives(): Promise<LiveSummary[]> {
  const rooms = await matchMaker.query({ name: ROOM_LIVE });
  return rooms
    .filter((room) => room.metadata && room.metadata.ended !== true)
    .map((room) => ({
      liveId: String(room.metadata.liveId ?? room.roomId),
      hostId: String(room.metadata.hostId ?? ''),
      hostName: String(room.metadata.hostName ?? ''),
      title: String(room.metadata.title ?? ''),
      category: String(room.metadata.category ?? 'geral'),
      realViewers: Number(room.metadata.realViewers ?? 0),
      isPK: room.metadata.isPK === true,
      agency: String(room.metadata.agency ?? ''),
      startedAt: Number(room.metadata.startedAt ?? 0),
    }))
    // Busiest first: the feed's default ordering (PRD §11).
    .sort((a, b) => b.realViewers - a.realViewers);
}

export const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// filterBy is what shards the world: a full central-plaza-001 makes the
// matchmaker create a second plaza instead of overfilling the first (§17).
gameServer.define(ROOM_CITY, CityRoom).filterBy(['sceneId']);
gameServer.define(ROOM_APARTMENT, ApartmentRoom).filterBy(['ownerId']);
gameServer.define(ROOM_LIVE, LiveRoom).filterBy(['liveId']);

export async function start(port = config.port, host = config.host): Promise<void> {
  await gameServer.listen(port, host);
  console.log(`[game-server] ouvindo em ws://${host}:${port} (${config.env})`);
  if (!isProduction() && !config.authSecret) {
    console.warn('[game-server] sem AUTH_JWT_SECRET: tokens de desenvolvimento aceitos.');
  }
}

// Only auto-start when run directly — tests import the rooms without opening
// a socket.
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  start().catch((err) => {
    console.error('[game-server] falha ao subir:', err);
    process.exit(1);
  });
}
