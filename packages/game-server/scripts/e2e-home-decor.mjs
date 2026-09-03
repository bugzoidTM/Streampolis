#!/usr/bin/env node
/**
 * A mobília do apartamento é OBSTÁCULO, e quem diz isso é o servidor.
 *
 * O que se prova aqui, sem navegador nenhum:
 *   1. a sala publica a mobília COM posição (era uma lista de ids, e uma lista
 *      de ids não vira colisão — o servidor resolvia o movimento num cômodo
 *      vazio enquanto o jogador via um cômodo cheio);
 *   2. andar contra o sofá PARA no sofá, na conta do servidor;
 *   3. redecorar no meio da sessão muda a sala: o dono avisa, a sala relê da
 *      API, e o móvel novo já é obstáculo antes de sair e voltar;
 *   4. o aviso não é uma porta dos fundos: um VISITANTE que o manda não move
 *      nada, e a mobília continua vindo da API.
 *
 * Pré-requisitos: packages/api migrado, semeado e no ar.
 *
 *   npm run e2e:decor --workspace @streampolis/game-server
 */
import { Client } from 'colyseus.js';

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
const SECRET = process.env.JWT_SECRET ?? 'dev-only-access-secret-change-me';
const SERVICE = process.env.API_SERVICE_TOKEN ?? 'dev-only-service-token';
const PORT = Number(process.env.E2E_DECOR_PORT ?? 2597);

process.env.AUTH_JWT_SECRET = SECRET;
process.env.API_BASE_URL = API;
process.env.API_SERVICE_TOKEN = SERVICE;

const { start, ROOM_APARTMENT } = await import('../dist/game-server/src/index.js');
const { FIXED_DT, PLAYER_RADIUS, PLACEABLES } = await import('../dist/shared/src/index.js');

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (label) => console.log(`\n${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, predicate, timeoutMs = 6_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const asUser = (token) => ({ authorization: `Bearer ${token}` });

async function login(username) {
  const { status, body } = await api('/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ username }),
  });
  if (status !== 200) throw new Error(`login de ${username} falhou (${status})`);
  return body;
}

const me = (room) => room.state.players.get(room.sessionId);

/** Meias-extensões de uma peça colocada, já com a meia-volta aplicada. */
function extents(placement) {
  const def = PLACEABLES[placement.itemId];
  const even = placement.turn % 2 === 0;
  return even ? [def.hw, def.hd] : [def.hd, def.hw];
}

/** Distância do ponto à CAIXA do móvel (0 = em cima da borda). */
function boxDistance(placement, p) {
  const [hw, hd] = extents(placement);
  const dx = Math.max(0, Math.abs(p.x - placement.x) - hw);
  const dz = Math.max(0, Math.abs(p.z - placement.z) - hd);
  return Math.hypot(dx, dz);
}

/** O ponto está dentro do móvel? O raio do jogador conta; 1 cm de folga. */
function inside(placement, p) {
  return boxDistance(placement, p) < PLAYER_RADIUS - 0.01;
}

/**
 * Caminha em linha reta CONTRA um móvel e conta o que aconteceu no caminho.
 *
 * Amostrado a cada passo, e não só no fim: quem atravessa um sofá e sai do
 * outro lado termina numa posição impecável. E o fim, sozinho, também não diz
 * se chegou a encostar — o solver faz deslizar, e uma caminhada longa acaba
 * sempre num canto qualquer da sala.
 */
async function walkInto(room, target, ticks, seq0) {
  const from = { x: me(room).x, z: me(room).z };
  const dx = target.x - from.x;
  const dz = target.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  let closest = Infinity;
  let breached = null;
  for (let i = 0; i < ticks; i++) {
    room.send('move', { dx: dx / len, dz: dz / len, yaw: Math.atan2(dx, dz), run: false, seq: seq0 + i });
    await sleep(FIXED_DT * 1000);
    const p = { x: me(room).x, z: me(room).z };
    closest = Math.min(closest, boxDistance(target, p));
    if (inside(target, p)) breached = p;
  }
  await sleep(120);
  const p = me(room);
  return { closest, breached, final: { x: p.x, z: p.z } };
}

async function main() {
  const health = await api('/health');
  if (health.status !== 200) {
    console.error(`API não respondeu em ${API}. Suba packages/api antes.`);
    process.exit(2);
  }

  await start(PORT, '127.0.0.1');
  const endpoint = `ws://127.0.0.1:${PORT}`;

  const ana = await login('ana');
  const beto = await login('beto');
  const home = (await api('/me/home', { headers: asUser(ana.token) })).body.home;

  // Planta conhecida, para a prova não depender do que estiver semeado: um sofá
  // atravessado no caminho, e nada mais.
  const SOFA = { itemId: 'fur_sofa_01', x: -1.0, z: 0.0, turn: 0 };
  const original = home.decor;
  const put = async (placements) => {
    const r = await api('/me/home/layout', {
      method: 'PUT', headers: asUser(ana.token), body: JSON.stringify({ placements }),
    });
    if (r.status !== 200) {
      console.error('a API recusou a planta de teste:', r.status, JSON.stringify(r.body));
      process.exit(2);
    }
    return r;
  };
  await put([SOFA]);

  step('1) A sala publica a mobília COM posição');
  const client = new Client(endpoint);
  const room = await client.joinOrCreate(ROOM_APARTMENT, { token: ana.token, apartmentId: home.apartmentId });
  await waitFor('primeiro patch', () => room.state?.players !== undefined);
  await waitFor('mobília no estado', () => (room.state.decor?.length ?? 0) > 0);

  const decor = [...(room.state.decor ?? [])];
  check('o sofá chegou à sala', decor.length === 1, `${decor.length} peças`);
  check('e chegou com a posição que a API guardou',
    decor[0]?.itemId === SOFA.itemId
    && Math.abs(decor[0]?.x - SOFA.x) < 1e-3 && Math.abs(decor[0]?.z - SOFA.z) < 1e-3
    && decor[0]?.turn === SOFA.turn,
    JSON.stringify(decor[0]));

  step('2) Andar contra o sofá para NO sofá');
  const contra = await walkInto(room, SOFA, 40, 1);
  check('o caminho realmente ENCOSTA no sofá', contra.closest < PLAYER_RADIUS + 0.12,
    `chegou a ${contra.closest.toFixed(2)} m da caixa`);
  check('e o servidor não deixou entrar nele', contra.breached === null,
    contra.breached ? `entrou em (${contra.breached.x.toFixed(2)}, ${contra.breached.z.toFixed(2)})` : '');

  step('3) Redecorar no meio da sessão muda a sala');
  const MESA = { itemId: 'fur_desk_01', x: 1.6, z: 0.0, turn: 0 };
  await put([SOFA, MESA]);
  room.send('redecorate', {});
  const chegou = await waitFor('a sala reler a planta', () => (room.state.decor?.length ?? 0) === 2);
  check('a sala releu a planta na API sozinha', chegou, `${room.state.decor?.length} peças`);

  // E o móvel novo já é obstáculo, sem sair e voltar.
  const contra2 = await walkInto(room, MESA, 60, 200);
  check('o caminho encosta na peça nova', contra2.closest < PLAYER_RADIUS + 0.12,
    `chegou a ${contra2.closest.toFixed(2)} m da caixa`);
  check('e o móvel recém-posto já barra o caminho', contra2.breached === null,
    contra2.breached ? `entrou em (${contra2.breached.x.toFixed(2)}, ${contra2.breached.z.toFixed(2)})` : '');

  step('4) O aviso não é porta dos fundos');
  const visita = new Client(endpoint);
  const roomB = await visita.joinOrCreate(ROOM_APARTMENT, { token: beto.token, apartmentId: home.apartmentId });
  await waitFor('visitante dentro', () => roomB.state?.decor !== undefined);
  await put([SOFA]);
  roomB.send('redecorate', {});
  await sleep(600);
  check('visitante mandando "redecorei" não mexe na sala',
    (room.state.decor?.length ?? 0) === 2, `${room.state.decor?.length} peças`);
  room.send('redecorate', {});
  await waitFor('o dono, sim', () => (room.state.decor?.length ?? 0) === 1);
  check('e o dono continua podendo', (room.state.decor?.length ?? 0) === 1);

  await roomB.leave();
  await room.leave();
  // A casa da Ana volta a ser a que era: o e2e roda contra o banco de
  // desenvolvimento de verdade, e um teste que deixa lixo é um teste que muda
  // o que o próximo vai medir.
  await put(original);
  console.log(failures === 0
    ? `\n✅ ${checks}/${checks} verificações passaram.`
    : `\n❌ ${failures} de ${checks} falharam.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
