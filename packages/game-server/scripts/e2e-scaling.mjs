#!/usr/bin/env node
/** Real Redis + two OS processes + worker-path proxy + real SDK sockets. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'colyseus.js';

if (!process.env.REDIS_URL) throw new Error('Set REDIS_URL to an isolated, disposable Redis instance. Never use production Redis.');
const basePort = Number(process.env.E2E_SCALING_PORT ?? 2610);
const gatewayPort = basePort + 2;
const workers = [];
const sockets = new Set();
const rooms = [];
let turn = 0;

function route(url = '/') {
  const match = /^\/([12])\//.exec(url);
  return { worker: match ? Number(match[1]) - 1 : turn++ % 2,
    path: match ? url.slice(2) : url };
}

// The same fixed path contract as deploy/game-nginx.conf. No arbitrary hosts.
const proxy = http.createServer((req, res) => {
  const target = route(req.url);
  const upstream = http.request({ hostname: '127.0.0.1', port: basePort + target.worker,
    path: target.path, method: req.method, headers: req.headers }, (reply) => {
    res.writeHead(reply.statusCode, reply.headers);
    reply.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502).end());
  req.pipe(upstream);
});
proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
proxy.on('upgrade', (req, socket, head) => {
  const target = route(req.url);
  const upstream = http.request({ hostname: '127.0.0.1', port: basePort + target.worker,
    path: target.path, headers: req.headers });
  upstream.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function health(worker) {
  try {
    const response = await fetch(`http://127.0.0.1:${basePort + worker}/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? response.json() : null;
  } catch { return null; }
}

async function stop(worker) {
  const child = workers[worker];
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(force); }
}

try {
  proxy.listen(gatewayPort, '127.0.0.1');
  await once(proxy, 'listening');
  for (let worker = 0; worker < 2; worker++) {
    const child = fork(new URL('../dist/game-server/src/index.js', import.meta.url), [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_ENV: 'development', AUTH_DEV_BYPASS: '1', AUTH_JWT_SECRET: '',
        API_BASE_URL: '', API_SERVICE_TOKEN: '', GAME_SERVER_HOST: '127.0.0.1',
        GAME_SERVER_PORT: String(basePort + worker), GAME_SERVER_DISTRIBUTED: '1',
        GAME_SERVER_ID: `scaling_test_${process.pid}_${worker}`,
        GAME_SERVER_PUBLIC_ADDRESS: `127.0.0.1:${gatewayPort}/${worker + 1}`,
        CITY_CAPACITY: '2' },
    });
    child.stdout.on('data', (data) => process.stdout.write(`[worker ${worker + 1}] ${data}`));
    child.stderr.on('data', (data) => process.stderr.write(`[worker ${worker + 1}] ${data}`));
    workers.push(child);
    await until(() => health(worker), `worker ${worker + 1} ready`);
  }
  const first = await health(0);
  const second = await health(1);
  assert.equal(first.mode, 'redis');
  assert.equal(second.mode, 'redis');
  assert.notEqual(first.processId, second.processId);
  assert.notEqual(first.serverId, second.serverId);

  const client = new Client(`ws://127.0.0.1:${gatewayPort}`);
  const reservations = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/matchmake/create/city`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: `scale_${i}`, sceneId: 'central_plaza' }),
    });
    const reservation = await response.json();
    assert.equal(response.ok, true, JSON.stringify(reservation));
    reservations.push(reservation);
    const room = await client.consumeSeatReservation(reservation);
    room.onMessage('chatMessage', () => {});
    rooms.push(room);
    await until(() => room.state?.players?.has(room.sessionId), 'socket routed to owning worker');
    // Colyseus 0.16 coalesces room-count publication for one second.
    if (i === 0) await delay(1_100);
  }
  assert.equal(new Set(reservations.map((r) => r.room.processId)).size, 2, 'rooms distributed across two processes');
  assert.deepEqual(new Set(reservations.map((r) => r.room.publicAddress)),
    new Set([`127.0.0.1:${gatewayPort}/1`, `127.0.0.1:${gatewayPort}/2`]));

  // Request a room through the OTHER worker; Redis reserves the remote seat,
  // and publicAddress sends the SDK back to the owning process.
  const target = reservations[0];
  const owner = target.room.processId === first.processId ? 0 : 1;
  const oppositeClient = new Client(`ws://127.0.0.1:${basePort + (1 - owner)}`);
  const friend = await oppositeClient.joinById(target.room.roomId, { token: 'scale_friend' });
  friend.onMessage('chatMessage', () => {});
  rooms.push(friend);
  await until(() => friend.state?.players?.size === 2, 'cross-worker joinById');
  assert.equal(friend.roomId, rooms[0].roomId);
  const otherShard = rooms[1];
  assert.equal(otherShard.state.players.size, 1, 'shard state stays isolated');
  const inbox = [];
  friend.onMessage('chatMessage', (message) => inbox.push(message.text));
  rooms[0].send('chat', { text: 'Redis encaminhou a sala certa' });
  await until(() => inbox.includes('Redis encaminhou a sala certa'), 'chat through worker routes');

  await assert.rejects(oppositeClient.joinById(target.room.roomId, { token: 'scale_full' }), /full|locked/i);
  await stop(owner);
  assert.equal((await health(1 - owner)).ok, true, 'other worker remains healthy');
  const survivor = await new Client(`ws://127.0.0.1:${basePort + 1 - owner}`)
    .joinById(otherShard.roomId, { token: 'scale_survivor' });
  survivor.onMessage('chatMessage', () => {});
  rooms.push(survivor);
  await until(() => survivor.state?.players?.size === 2, 'surviving room accepts clients after peer shutdown');
  console.log('PASS: two Redis workers, unique process identities, worker paths, cross-process join, chat, capacity, and graceful peer shutdown.');
} finally {
  await Promise.all(workers.map((_, worker) => stop(worker)));
  for (const socket of sockets) socket.destroy();
  proxy.close();
}
