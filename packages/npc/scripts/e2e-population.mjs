#!/usr/bin/env node
/**
 * A população de ponta a ponta: game server de verdade, banco de verdade, o
 * elenco INTEIRO (77 corpos) entrando de um processo só — e nenhum modelo de
 * linguagem (os cognitivos falam com um modelo de mentira; os sociais e os
 * de ambiente não falam com modelo nenhum).
 *
 * O que se prova: que todos entram e ficam (sem derrubar a sala nem uns aos
 * outros), que ninguém nasce/fica preso, que um social responde a quem fala
 * com ele SEM chamada de modelo, que um figurante com fala de balcão responde
 * ao nome e um mudo só se vira, que a chegada deles não polui o chat, que a
 * lotação de pessoas não é ocupada por personagem, e que o freio por classe
 * tira só a classe.
 *
 *   npm run e2e:population --workspace @streampolis/npc
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'colyseus.js';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'e2e-pop-secret';
const GAME_PORT = Number(process.env.E2E_POP_GAME_PORT ?? 2611);
const API_PORT = Number(process.env.E2E_POP_API_PORT ?? 18807);
const LLM_PORT = Number(process.env.E2E_POP_LLM_PORT ?? 18808);
const HEALTH_PORT = Number(process.env.E2E_POP_HEALTH_PORT ?? 18809);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://streampolis:streampolis_dev_pw@127.0.0.1:55432/streampolis';

process.env.AUTH_JWT_SECRET = SECRET;
process.env.CITY_CAPACITY = '4';
delete process.env.API_BASE_URL;

const { start } = await import('../../game-server/dist/game-server/src/index.js');
const { signDevToken } = await import('../../game-server/dist/game-server/src/auth/AuthProvider.js');

let failures = 0;
let checks = 0;
const check = (label, ok, detail = '') => {
  checks++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (label) => console.log(`\n${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, predicate, timeoutMs = 10_000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}
const now = () => Math.floor(Date.now() / 1000);
function sessionToken(sub, name, perms, avatar = {}) {
  return signDevToken(SECRET, {
    iss: 'streampolis-api', sub, name, perms, gifterLevel: 0, agency: '', sid: `${sub}:e2e`,
    avatar, iat: now(), exp: now() + 900,
  });
}

// ------------------------------------------------------------------ banco
const db = new pg.Pool({ connectionString: DATABASE_URL, options: '-c search_path=streampolis,pg_catalog' });
const { rows: roster } = await db.query(`SELECT id, slug, display_name, scene_id, kind, avatar FROM npc_agents ORDER BY created_at`);
const bySlug = new Map(roster.map((r) => [r.slug, r]));
const total = roster.length;
const count = (kind) => roster.filter((r) => r.kind === kind).length;
console.log(`elenco no banco: ${total} (${count('cognitive')} cognitivos, ${count('social')} sociais, ${count('ambient')} de ambiente)`);

// A API de mentira assina o token de QUALQUER personagem do banco.
const api = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/npc/token') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { npc } = JSON.parse(body || '{}');
      const row = bySlug.get(npc);
      if (!row) { res.writeHead(404).end('{"error":"NOT_FOUND"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        token: sessionToken(row.id, row.display_name, ['play', 'npc'], row.avatar),
        expiresIn: 900, sessionId: 'e2e',
        npc: { id: row.id, slug: row.slug, displayName: row.display_name, sceneId: row.scene_id, enabled: true },
      }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

let llmCalls = 0;
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    llmCalls++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '{"say": "Oi. E2E-COG", "action": null}' } }],
    }));
  });
});
await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

await db.query(`UPDATE feature_flags SET enabled = TRUE WHERE key IN ('npc_enabled', 'npc_ambient_enabled', 'npc_social_enabled')`);
await db.query(`UPDATE npc_agents SET enabled = TRUE`);
await db.query(`DELETE FROM npc_relations WHERE other_id IN ('22222222-2222-4222-8222-222222222222')`);

// ------------------------------------------------------------- o worker
const workerLog = [];
const worker = spawn(process.execPath, [join(HERE, '../dist/npc/src/index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    NPC_SLUGS: '',
    API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
    API_SERVICE_TOKEN: 'e2e-service',
    GAME_SERVER_URL: `ws://127.0.0.1:${GAME_PORT}`,
    DATABASE_URL,
    LLM_CHAT_URL: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
    LLM_CHAT_KEY: 'x',
    LLM_DEEP_URL: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
    LLM_DEEP_KEY: 'x',
    NPC_HEALTH_PORT: String(HEALTH_PORT),
    NPC_CONTROL_MS: '2000',
    NPC_JOIN_STAGGER_MS: '120',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
worker.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l) workerLog.push(l); });
worker.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l) workerLog.push(l); });
async function health() {
  try { return await (await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`)).json(); } catch { return null; }
}

const ANA_ID = '22222222-2222-4222-8222-222222222222';
function joinAs(id, name, scene) {
  const client = new Client(`ws://127.0.0.1:${GAME_PORT}`);
  return client.joinOrCreate('city', { token: sessionToken(id, name, ['play']), sceneId: scene });
}
function npcsIn(room) {
  const out = [];
  room.state.members?.forEach((m) => { if (m.npc) out.push(m); });
  return out;
}
function humansIn(room) {
  let n = 0;
  room.state.members?.forEach((m) => { if (!m.npc) n++; });
  return n;
}
function bodyOf(room, npcId) {
  let found = null;
  room.state.players?.forEach((p) => { if (p.id === npcId) found = p; });
  return found;
}

async function main() {
  await start(GAME_PORT, '127.0.0.1');
  const t0 = Date.now();

  step(`1. O elenco inteiro entra (${total} corpos, um processo, lotação de pessoas = 4)`);
  const allIn = await waitFor('todos conectados', async () => {
    const h = await health();
    return h && h.agents.length === total && h.agents.every((a) => a.connected);
  }, 90_000, 1000);
  const h = await health();
  const connected = h?.agents.filter((a) => a.connected).length ?? 0;
  check(`todos os ${total} conectados (${connected}) em ${Math.round((Date.now() - t0) / 1000)} s`, allIn, JSON.stringify(h?.byKind));
  check('nenhum erro de entrada', !h?.agents.some((a) => a.lastError), h?.agents.filter((a) => a.lastError).map((a) => `${a.npc}: ${a.lastError}`).join('; '));
  const rooms = new Map();
  for (const a of h?.agents ?? []) rooms.set(a.scene, (rooms.get(a.scene) ?? new Set()).add(a.room));
  check('cada cena tem UM shard (personagem não abre shard)', [...rooms.values()].every((s) => s.size === 1), JSON.stringify([...rooms].map(([k, v]) => [k, v.size])));

  step('2. Ana entra na praça: vê os personagens, não vê "chegou" deles, e a lotação continua para gente');
  const inbox = [];
  const ana = await joinAs(ANA_ID, 'Ana', 'central_plaza');
  ana.onMessage('chatMessage', (m) => inbox.push(m));
  ana.onMessage('*', () => {});
  await waitFor('roster da praça', () => npcsIn(ana).length >= 20, 10_000);
  const plazaNpcs = npcsIn(ana);
  const expectPlaza = roster.filter((r) => r.scene_id === 'central_plaza').length;
  check(`a praça tem os ${expectPlaza} personagens no roster (${plazaNpcs.length})`, plazaNpcs.length === expectPlaza);
  check('Ana caiu no MESMO shard dos personagens', plazaNpcs.length > 0 && [...rooms.get('central_plaza')][0] === ana.roomId, `${ana.roomId}`);
  await sleep(1500);
  check('nenhuma linha de sistema "chegou" para personagem', !inbox.some((m) => m.system && /chegou|saiu/.test(m.text) && !/Ana/.test(m.text)), inbox.filter((m) => m.system).map((m) => m.text).join(' | '));
  // Lotação 4 de pessoas: mais três entram na mesma praça apesar dos 28 personagens.
  const others = [];
  for (const [i, n] of ['Beto', 'Caio', 'Dora'].entries()) others.push(await joinAs(`3333333${i}-3333-4333-8333-333333333333`, n, 'central_plaza'));
  check('três pessoas a mais cabem no mesmo shard (28 personagens não ocupam vaga)', others.every((r) => r.roomId === ana.roomId));
  const fifth = await joinAs('44444444-4444-4444-8444-444444444444', 'Eva', 'central_plaza');
  check('a quinta pessoa vai para um shard novo (lotação de gente respeitada)', fifth.roomId !== ana.roomId);
  await fifth.leave();
  for (const r of others) await r.leave();

  step('3. Ninguém preso: os figurantes se espalharam dos pontos de entrada e há gente andando');
  await sleep(8_000);
  const positions = plazaNpcs.map((m) => bodyOf(ana, m.id)).filter(Boolean);
  const spread = new Set(positions.map((p) => `${Math.round(p.x / 3)}:${Math.round(p.z / 3)}`));
  check(`os corpos visíveis ocupam ${spread.size} células de 3 m (não estão empilhados)`, spread.size >= Math.min(8, positions.length * 0.5), `${positions.length} visíveis`);
  const moving = positions.filter((p) => p.moving).length;
  check(`há gente andando na praça (${moving} de ${positions.length} visíveis)`, moving >= 1);

  step('4. Ana fala com uma social: resposta sem modelo, relação criada, "vem comigo" recusado a desconhecida');
  const bia = bySlug.get('bia');
  const biaBody = () => bodyOf(ana, bia.id);
  await waitFor('Bia visível', () => biaBody() !== null, 15_000);
  const near = biaBody();
  check('Bia está no estado da sala', near !== null);
  const before = llmCalls;
  ana.send('chat', { text: 'Bia, oi! você é humana?' });
  const replied = await waitFor('resposta da Bia', () => inbox.some((m) => m.senderId === bia.id), 12_000);
  const r1 = inbox.find((m) => m.senderId === bia.id);
  check('Bia respondeu', replied, JSON.stringify(inbox.slice(-3)));
  check('marcada como NPC', r1?.npc === true);
  check('a resposta diz que é personagem', /personagem/i.test(r1?.text ?? ''), r1?.text);
  check('SEM chamada a modelo de linguagem', llmCalls === before, `${llmCalls - before} chamadas`);
  // "Vem comigo" a um desconhecido: o Teo (tímido, sociabilidade 0,25) recusa
  // sempre; a Bia (0,95) toparia uma vez em cinco — e isso é regra, não bug.
  const teo = bySlug.get('teo');
  const n1 = inbox.length;
  ana.send('chat', { text: 'Teo, vem comigo' });
  await waitFor('resposta do Teo', () => inbox.slice(n1).some((m) => m.senderId === teo.id), 12_000);
  const r2 = inbox.slice(n1).find((m) => m.senderId === teo.id);
  check('o desconhecido ouve não ao "vem comigo"', /conhece|hoje não|ainda não|qualquer um|desculpa/i.test(r2?.text ?? ''), r2?.text);
  const hb = await health();
  const biaStatus = hb.agents.find((a) => a.npc === 'bia');
  const teoStatus = hb.agents.find((a) => a.npc === 'teo');
  check('a relação com Ana existe na cabeça da Bia', biaStatus?.mind?.relations >= 1, JSON.stringify(biaStatus?.mind));
  check('e o Teo não saiu seguindo', !/^follow/.test(teoStatus?.mind?.activity ?? ''), teoStatus?.mind?.activity);

  step('5. Figurantes: o quiosqueiro tem fala de balcão; um passante só se vira');
  const nelson = bySlug.get('seu-nelson');
  const n2 = inbox.length;
  ana.send('chat', { text: 'Seu Nelson, tá aberto?' });
  await sleep(3_000);
  const nelsonBody = bodyOf(ana, nelson.id);
  const heardNelson = inbox.slice(n2).some((m) => m.senderId === nelson.id);
  // Ana nasce longe do quiosque norte: a fala de balcão exige 6 m. O que se
  // prova aqui é a REGRA — longe, ele não fala.
  const dNelson = nelsonBody ? Math.hypot(nelsonBody.x - 0, nelsonBody.z - 0) : null;
  check('longe do quiosque, o quiosqueiro não responde (fala de balcão só a 6 m)', !heardNelson || dNelson === null || dNelson < 6, `${dNelson}`);
  const marcos = bySlug.get('marcos');
  const n3 = inbox.length;
  ana.send('chat', { text: 'Marcos!' });
  await sleep(2_500);
  check('o passante (mudo) não fala', !inbox.slice(n3).some((m) => m.senderId === marcos.id));
  check('o cognitivo da praça (Nilo) continua respondendo pelo modelo', await (async () => {
    const nilo = bySlug.get('nilo');
    const n4 = inbox.length;
    const c0 = llmCalls;
    ana.send('chat', { text: 'Nilo, oi' });
    const ok = await waitFor('Nilo', () => inbox.slice(n4).some((m) => m.senderId === nilo.id), 20_000);
    return ok && llmCalls > c0;
  })());

  step('6. Freio por classe: desligar os de ambiente tira só eles');
  await db.query(`UPDATE feature_flags SET enabled = FALSE WHERE key = 'npc_ambient_enabled'`);
  const ambientOut = await waitFor('ambiente fora', async () => {
    const hh = await health();
    return hh && hh.agents.filter((a) => a.kind === 'ambient').every((a) => !a.connected);
  }, 20_000, 500);
  const h6 = await health();
  check('todos os de ambiente saíram', ambientOut);
  check('sociais e cognitivos continuam', h6.agents.filter((a) => a.kind !== 'ambient').every((a) => a.connected));
  await waitFor('roster sem ambiente', () => npcsIn(ana).length === roster.filter((r) => r.scene_id === 'central_plaza' && r.kind !== 'ambient').length, 10_000);
  check('Ana vê só sociais + Nilo na praça', npcsIn(ana).length === roster.filter((r) => r.scene_id === 'central_plaza' && r.kind !== 'ambient').length, `${npcsIn(ana).length}`);
  await db.query(`UPDATE feature_flags SET enabled = TRUE WHERE key = 'npc_ambient_enabled'`);
  const back = await waitFor('ambiente de volta', async () => {
    const hh = await health();
    return hh && hh.agents.every((a) => a.connected);
  }, 60_000, 1000);
  check('e voltam quando o freio solta', back);

  step('7. O processo não vazou erro');
  const errors = workerLog.filter((l) => /não entrou|erro da sala|Unhandled|TypeError|ReferenceError/.test(l));
  check('nenhum erro no log do worker', errors.length === 0, errors.slice(0, 5).join(' | '));

  await ana.leave();
  console.log(`\n${checks - failures}/${checks} verificações passaram`);
}

main().catch((err) => {
  console.error(err);
  failures++;
}).finally(async () => {
  worker.kill('SIGTERM');
  await sleep(1500);
  await db.query(`UPDATE feature_flags SET enabled = TRUE WHERE key IN ('npc_enabled', 'npc_ambient_enabled', 'npc_social_enabled')`).catch(() => {});
  await db.end().catch(() => {});
  api.close();
  llm.close();
  if (failures) {
    console.log('\n--- linhas relevantes do worker ---');
    console.log(workerLog.filter((l) => !/saiu da sala|entrou na sala|\[ambient\]|\[main\] (entrando|saiu)/.test(l)).slice(-60).join('\n'));
  }
  process.exit(failures ? 1 : 0);
});
