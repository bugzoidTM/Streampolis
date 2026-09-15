#!/usr/bin/env node
/**
 * O personagem de ponta a ponta: sala de verdade, socket de verdade, banco de
 * verdade — e um "modelo" de mentira.
 *
 * O que se prova aqui é o CONTRATO, não a inteligência: que o worker entra na
 * praça com a marca de NPC assinada, que responde a quem fala com ele, que a
 * fala chega aos outros com `npc: true`, que a reflexão escreve diário e
 * propõe uma persona nova que o auditor aprova, e que o freio de mão o tira
 * da sala sem redeploy. O modelo é um servidor HTTP deste arquivo que
 * responde o que cada prompt pede.
 *
 * Pré-requisitos: Postgres de dev em :55432 com `npm run migrate` aplicado
 * (0021_npc.sql). O script limpa o que criou ao final.
 *
 *   npm run e2e --workspace @streampolis/npc
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'colyseus.js';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SECRET = 'e2e-npc-secret';
const GAME_PORT = Number(process.env.E2E_NPC_GAME_PORT ?? 2601);
const API_PORT = Number(process.env.E2E_NPC_API_PORT ?? 18797);
const LLM_PORT = Number(process.env.E2E_NPC_LLM_PORT ?? 18798);
const HEALTH_PORT = Number(process.env.E2E_NPC_HEALTH_PORT ?? 18799);
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://streampolis:streampolis_dev_pw@127.0.0.1:55432/streampolis';
const NPC_ID = '5e1f0000-0000-4000-8000-000000000001';
/** Fixtures deste roteiro. O código do personagem não conhece nome nenhum: segue o `userId` de quem pediu. */
const NPC_NAME = 'Nilo';
const PLAYER_NAME = 'Ana';

process.env.AUTH_JWT_SECRET = SECRET;
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
async function waitFor(label, predicate, timeoutMs = 10_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

const now = () => Math.floor(Date.now() / 1000);
function sessionToken(sub, name, perms) {
  return signDevToken(SECRET, {
    iss: 'streampolis-api', sub, name, perms, gifterLevel: 0, agency: '', sid: `${sub}:e2e`,
    avatar: {}, iat: now(), exp: now() + 900,
  });
}

// --------------------------------------------------------- a API de mentira
const api = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/internal/npc/token') {
    if (req.headers.authorization !== 'Bearer e2e-service') {
      res.writeHead(401).end('{"error":"service_auth_required"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      token: sessionToken(NPC_ID, 'Nilo', ['play', 'npc']),
      expiresIn: 900,
      sessionId: 'e2e',
      npc: { id: NPC_ID, slug: 'nilo', displayName: 'Nilo', sceneId: 'central_plaza', enabled: true },
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

// ------------------------------------------------------ o modelo de mentira
const llmCalls = [];
const llm = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { messages = [] } = JSON.parse(body || '{}');
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    let content;
    if (system.includes('AUDITOR')) {
      content = '{"approved": true, "violations": [], "notes": "mudança pequena e fundamentada"}';
      llmCalls.push('audit');
    } else if (system.includes('revisando quem você é')) {
      const start = user.indexOf('PERSONA ATUAL (JSON):') + 'PERSONA ATUAL (JSON):'.length;
      const end = user.indexOf('DIÁRIOS RECENTES');
      const current = JSON.parse(user.slice(start, end).trim());
      current.history = [...current.history, 'Conheceu Ana, que veio testar a praça.'];
      current.relationships = ['Ana: a primeira pessoa que falou comigo.'];
      content = '```json\n' + JSON.stringify(current) + '\n```';
      llmCalls.push('proposal');
    } else if (system.includes('escrevendo no seu diário')) {
      content = 'Hoje a Ana apareceu na praça e falou comigo. Foi a primeira conversa de verdade. Ela disse que veio testar; eu disse quem sou.';
      llmCalls.push('diary');
    } else if (user.startsWith('DELIBERAÇÃO')) {
      // Autonomia: o personagem decide o que fazer. O modelo de mentira manda-o olhar o telão por 3 min.
      content = JSON.stringify({ goal: 'ver o que passa no telão hoje', why: 'a praça está quieta', skill: 'watch_telao', params: {}, minutes: 3, say: null });
      llmCalls.push('deliberate');
    } else {
      // Conversa: a fala carrega uma frase que só o modelo de mentira diria.
      const who = /^(.+?) acabou de dizer/m.exec(user)?.[1] ?? 'você';
      if (/me segue/i.test(user)) {
        content = JSON.stringify({ say: `Claro, ${who}, vou contigo. E2E-FOLLOW`, action: { type: 'follow' } });
        llmCalls.push('follow');
      } else {
        content = JSON.stringify({ say: `Oi, ${who}! Eu sou o Nilo, personagem daqui da praça. E2E-OK`, note: 'veio testar a praça' });
        llmCalls.push('chat');
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
    }));
  });
});
await new Promise((r) => llm.listen(LLM_PORT, '127.0.0.1', r));

// ------------------------------------------------------------------ banco
const db = new pg.Pool({ connectionString: DATABASE_URL, options: '-c search_path=streampolis,pg_catalog' });
async function cleanup() {
  await db.query(`DELETE FROM npc_memory WHERE npc_id = $1`, [NPC_ID]);
  await db.query(`DELETE FROM npc_people WHERE npc_id = $1`, [NPC_ID]);
  await db.query(`DELETE FROM npc_diary WHERE npc_id = $1`, [NPC_ID]);
  await db.query(`DELETE FROM npc_calls WHERE npc_id = $1`, [NPC_ID]);
  await db.query(`DELETE FROM npc_intentions WHERE npc_id = $1`, [NPC_ID]);
  await db.query(`DELETE FROM npc_persona_versions WHERE npc_id = $1 AND version > 1`, [NPC_ID]);
  await db.query(`UPDATE npc_persona_versions SET status = 'active' WHERE npc_id = $1 AND version = 1`, [NPC_ID]);
  await db.query(`UPDATE feature_flags SET enabled = TRUE WHERE key = 'npc_enabled'`);
  await db.query(`UPDATE npc_agents SET enabled = TRUE, last_heartbeat = NULL, room_id = NULL WHERE id = $1`, [NPC_ID]);
}

// ------------------------------------------------------------- o worker
let worker = null;
const workerLog = [];
function startWorker() {
  worker = spawn(process.execPath, [join(HERE, '../dist/npc/src/index.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NPC_SLUG: 'nilo',
      API_BASE_URL: `http://127.0.0.1:${API_PORT}`,
      API_SERVICE_TOKEN: 'e2e-service',
      GAME_SERVER_URL: `ws://127.0.0.1:${GAME_PORT}`,
      DATABASE_URL,
      LLM_CHAT_URL: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      LLM_CHAT_KEY: 'x',
      LLM_DEEP_URL: `http://127.0.0.1:${LLM_PORT}/v1/chat/completions`,
      LLM_DEEP_KEY: 'x',
      NPC_HEALTH_PORT: String(HEALTH_PORT),
      NPC_REFLECT_EXCHANGES: '1',
      NPC_REFLECT_CHECK_MS: '1500',
      NPC_CONTROL_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l) workerLog.push(l); });
  worker.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l) workerLog.push(l); });
}
async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${HEALTH_PORT}/health`);
    return await r.json();
  } catch {
    return null;
  }
}

async function main() {
  await cleanup();
  await start(GAME_PORT, '127.0.0.1');

  step('1. O personagem entra na praça com a marca de NPC assinada');
  startWorker();
  const ana = new Client(`ws://127.0.0.1:${GAME_PORT}`);
  const ANA_ID = '11111111-1111-4111-8111-111111111111';
  const anaCity = await ana.joinOrCreate('city', { token: sessionToken(ANA_ID, 'Ana', ['play']), sceneId: 'central_plaza' });
  const inbox = [];
  anaCity.onMessage('chatMessage', (m) => inbox.push(m));
  anaCity.onMessage('*', () => {});

  let nilo = null;
  const seen = await waitFor('Nilo na sala', () => {
    anaCity.state.players?.forEach((p) => { if (p.id === NPC_ID) nilo = p; });
    return nilo !== null;
  }, 20_000);
  check('Nilo aparece no estado da sala', seen);
  check('com npc = true no PlayerState', nilo?.npc === true);
  check('com o nome da agente', nilo?.name === 'Nilo');
  let member = null;
  anaCity.state.members?.forEach((m) => { if (m.id === NPC_ID) member = m; });
  check('e npc = true no roster da cidade', member?.npc === true);

  const h1 = await health();
  check('/health diz conectado', h1?.connected === true, JSON.stringify(h1));

  step('1b. Livre e sem conversa, ele DECIDE o que fazer (uma deliberação, uma intenção que dura)');
  const decided = await waitFor('intenção própria', async () => {
    const r = await db.query(`SELECT skill, goal, source, planned_min FROM npc_intentions WHERE npc_id = $1 ORDER BY id DESC LIMIT 1`, [NPC_ID]);
    return r.rows[0]?.source === 'deliberation';
  }, 20_000, 500);
  const intent = (await db.query(`SELECT skill, goal, source, planned_min, outcome FROM npc_intentions WHERE npc_id = $1 ORDER BY id DESC LIMIT 1`, [NPC_ID])).rows[0];
  check('deliberou pelo modelo (uma chamada de propósito deliberate)', decided && llmCalls.includes('deliberate'), JSON.stringify(intent));
  check('a intenção registrada é a que o modelo escolheu (watch_telao, 3 min)', intent?.skill === 'watch_telao' && intent?.planned_min === 3, JSON.stringify(intent));
  const hd = await health();
  check('/health mostra a intenção em curso com o objetivo', hd?.brain?.intention?.goal === 'ver o que passa no telão hoje', JSON.stringify(hd?.brain?.intention));
  await sleep(4_000);
  check('e não delibera de novo a cada tique (uma só em 4 s)', llmCalls.filter((c) => c === 'deliberate').length === 1, `${llmCalls.filter((c) => c === 'deliberate').length}`);

  step('2. Ana fala com ele; ele responde e a fala chega marcada como NPC');
  anaCity.send('chat', { text: 'oi Nilo, tudo bem?' });
  const replied = await waitFor('resposta do Nilo', () => inbox.some((m) => m.senderId === NPC_ID), 15_000);
  check('Nilo respondeu no chat', replied);
  const reply = inbox.find((m) => m.senderId === NPC_ID);
  check('a mensagem dele vem com npc: true', reply?.npc === true, JSON.stringify(reply));
  check('a fala veio do modelo (passou pelo sanitizador)', reply?.text?.includes('E2E-OK') === true, reply?.text);
  check('o modelo foi chamado na camada de conversa', llmCalls.includes('chat'));

  const mem = await db.query(`SELECT kind, user_name, text FROM npc_memory WHERE npc_id = $1 ORDER BY id`, [NPC_ID]);
  check('ele lembrou o que ouviu', mem.rows.some((r) => r.kind === 'heard' && r.user_name === 'Ana'));
  check('e o que disse', mem.rows.some((r) => r.kind === 'said'));
  const person = await db.query(`SELECT user_name, exchanges, notes FROM npc_people WHERE npc_id = $1 AND user_id = $2`, [NPC_ID, ANA_ID]);
  check('Ana virou conhecida, com anotação', person.rows[0]?.exchanges === 1 && person.rows[0]?.notes?.length === 1, JSON.stringify(person.rows[0]));

  step(`2b. "me segue": ${NPC_NAME} acompanha ${PLAYER_NAME} a 2–3 m, desacelera ao chegar e para sem grudar`);
  const posOf = (id) => { let out = null; anaCity.state.players?.forEach((p) => { if (p.id === id) out = { x: p.x, z: p.z }; }); return out; };
  const gap = () => { const a = posOf(ANA_ID); const n = posOf(NPC_ID); return a && n ? Math.hypot(a.x - n.x, a.z - n.z) : NaN; };
  /** O jogador anda até um ponto (a 24 Hz, como o cliente), e devolve a menor distância do personagem vista no caminho. */
  const anaWalksTo = async (to, run = false, maxMs = 12_000) => {
    let seq = 1000; let minGap = Infinity; const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const a = posOf(ANA_ID); if (!a) break;
      const dx = to.x - a.x, dz = to.z - a.z, len = Math.hypot(dx, dz);
      if (len < 0.5) break;
      anaCity.send('move', { dx: dx / len, dz: dz / len, yaw: Math.atan2(dx, dz), run, seq: seq++ });
      minGap = Math.min(minGap, gap());
      await sleep(42);
    }
    return minGap;
  };
  await sleep(2_600); // intervalo mínimo entre respostas ao mesmo usuário
  anaCity.send('chat', { text: `${NPC_NAME}, me segue?` });
  const agreed = await waitFor('personagem topa seguir', () => inbox.some((m) => m.senderId === NPC_ID && m.text?.includes('E2E-FOLLOW')), 15_000);
  check('o modelo devolveu a ação follow e ele topou', agreed && llmCalls.includes('follow'));
  await anaWalksTo({ x: 0, z: 9 });
  let settled = await waitFor('personagem chega e para na faixa', () => gap() >= 1.85 && gap() <= 3.3, 15_000, 100);
  check(`ele chegou à faixa de 2–3 m (${gap().toFixed(2)} m)`, settled);
  // Assenta: um segundo sem a distância mudar (ele entra na faixa ainda freando).
  let gPrev = gap();
  await waitFor('personagem assenta', async () => { await sleep(1_000); const g = gap(); const same = Math.abs(g - gPrev) < 0.02; gPrev = g; return same; }, 10_000, 0);
  // Fica parado ao menos 3 s com ela parada: a distância não muda e ele não gruda.
  const g0 = gap(); let minStill = g0;
  for (let i = 0; i < 30; i++) { await sleep(100); minStill = Math.min(minStill, gap()); }
  check(`parado, ficou a ${gap().toFixed(2)} m (nunca abaixo de 1,85)`, Math.abs(gap() - g0) < 0.05 && minStill >= 1.85);
  // Ela anda mais 8 m: ele retoma, não passa do ponto e para de novo na faixa.
  const minWhileWalking = await anaWalksTo({ x: -8, z: 9 });
  check(`retomou sem passar por cima dela (mínimo ${minWhileWalking.toFixed(2)} m)`, minWhileWalking >= 1.85);
  settled = await waitFor('personagem para de novo na faixa', () => gap() >= 1.85 && gap() <= 3.3, 15_000, 100);
  check(`parou de novo na faixa (${gap().toFixed(2)} m)`, settled);
  const hf = await health();
  check(`status diz que está seguindo ${PLAYER_NAME}`, typeof hf?.brain?.action === 'string' && hf.brain.action.startsWith('follow'), JSON.stringify(hf?.brain?.action ?? hf));

  step('3. Reflexão: diário → proposta → auditor → persona v2 no ar');
  const reflected = await waitFor('reflexão', async () => (await health())?.reflections >= 1, 20_000, 300);
  check('a reflexão rodou', reflected);
  check('na ordem diário, proposta, auditoria', ['diary', 'proposal', 'audit'].every((k) => llmCalls.includes(k)), llmCalls.join(','));
  const diary = await db.query(`SELECT entry, memories FROM npc_diary WHERE npc_id = $1`, [NPC_ID]);
  // Duas conversas (o "oi" e o "me segue") podem render duas reflexões; o que se prova é o ciclo, não a contagem.
  check('o diário foi gravado', diary.rows.length >= 1 && diary.rows.every((r) => r.memories > 0));
  const versions = await db.query(`SELECT version, status, source, persona FROM npc_persona_versions WHERE npc_id = $1 ORDER BY version`, [NPC_ID]);
  const active = versions.rows.find((v) => v.status === 'active');
  check('há uma versão nova ativa vinda da reflexão', active && active.version >= 2 && active.source === 'reflection', JSON.stringify(versions.rows.map((v) => [v.version, v.status])));
  check('a v1 foi aposentada, não apagada', versions.rows.some((v) => v.version === 1 && v.status === 'retired'));
  check('o nome continua invariante', versions.rows.every((v) => v.persona.name === 'Nilo' && v.persona.kind === 'npc'));
  check('a mudança está na história', active?.persona.history.some((h) => h.includes('Ana')));
  const h2 = await waitFor('worker na versão ativa', async () => (await health())?.personaVersion === active?.version, 8_000, 200) ? await health() : await health();
  check('o worker está usando a versão ativa', h2?.personaVersion === active?.version, JSON.stringify([h2?.personaVersion, active?.version]));

  step('4. Reverter pelo banco (o que o painel faz) recarrega no worker');
  await db.query(`UPDATE npc_persona_versions SET status = 'retired' WHERE npc_id = $1 AND status = 'active'`, [NPC_ID]);
  await db.query(`UPDATE npc_persona_versions SET status = 'active' WHERE npc_id = $1 AND version = 1`, [NPC_ID]);
  const reverted = await waitFor('recarga da persona', async () => (await health())?.personaVersion === 1, 8_000, 200);
  check('o worker voltou para a v1 sem reiniciar', reverted);

  step('5. Freio de mão: a flag tira o personagem da sala');
  await db.query(`UPDATE feature_flags SET enabled = FALSE WHERE key = 'npc_enabled'`);
  const left = await waitFor('saída da sala', async () => (await health())?.connected === false, 8_000, 200);
  check('/health diz desconectado', left);
  let still = false;
  anaCity.state.players?.forEach((p) => { if (p.id === NPC_ID) still = true; });
  await sleep(300);
  still = false;
  anaCity.state.players?.forEach((p) => { if (p.id === NPC_ID) still = true; });
  check('Ana não vê mais o Nilo', !still);
  await db.query(`UPDATE feature_flags SET enabled = TRUE WHERE key = 'npc_enabled'`);
  const back = await waitFor('volta à sala', async () => (await health())?.connected === true, 10_000, 200);
  check('e volta quando a flag religa', back);

  await anaCity.leave();
}

try {
  await main();
} catch (err) {
  failures++;
  console.error('\n  ✗ exceção:', err);
} finally {
  if (worker) worker.kill('SIGTERM');
  await sleep(300);
  await cleanup().catch(() => {});
  await db.end();
  api.close();
  llm.close();
  if (failures) {
    console.log('\n--- log do worker ---');
    for (const l of workerLog.slice(-60)) console.log(l);
  }
  console.log(`\n${checks - failures}/${checks} verificações passaram`);
  process.exit(failures === 0 ? 0 : 1);
}
