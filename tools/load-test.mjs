#!/usr/bin/env node
/**
 * Teste de carga do ambiente de dois workers.
 *
 * A cidade com gente e uma live cheia ao mesmo tempo, medindo só o que o
 * servidor sente: CPU, memória, atraso do event loop, banda e quedas. Este
 * arquivo NÃO julga jogabilidade e não afirma nada sobre o que aparece na tela —
 * ele produz números, e os números vão para `docs/load-test.md`.
 *
 *   node tools/load-test.mjs --players=72 --viewers=100 --seconds=180
 *
 * ## Onde cada número nasce
 *
 * | grandeza | fonte | por quê |
 * | --- | --- | --- |
 * | CPU | `process.cpuUsage()` de cada worker, via `/health` | conta o PROCESSO, não o container: o driver roda na mesma máquina e contaminaria qualquer medida de host |
 * | RAM | `process.memoryUsage().rss` | idem; `docker stats` desconta cache e mente para menos |
 * | event loop | `monitorEventLoopDelay` dentro do worker | é a única que não existe de fora, e a que o jogador sente primeiro |
 * | banda | contadores de rede do container (`docker stats`) | os bytes que de fato cruzaram a interface, TLS e frame de WebSocket inclusos |
 * | quedas | `onLeave`/`onError` de cada cliente | quem caiu sozinho, separado de quem foi mandado embora no fim |
 *
 * ## O driver mora na mesma máquina
 *
 * 173 clientes WebSocket com TLS gastam CPU, e essa CPU é do mesmo host que
 * roda os workers. Por isso nenhuma medida do servidor vem de `top` ou da carga
 * do host: elas vêm de dentro do processo medido. A carga do host é anotada
 * assim mesmo, como contexto — se ela estourar, a rodada não vale.
 *
 * ## Contas
 *
 * `tools/load-users.mjs`, rodado dentro do container da API, cria as contas e
 * as apaga no fim. Os tokens são assinados aqui mesmo com `SP_JWT_SECRET`: o
 * caminho de `/auth` tem limitador de 10 por minuto e o teste precisa de 173
 * sessões em segundos — passar por ele mediria o limitador.
 */
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'colyseus.js';

const exec = promisify(execFile);

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const WS = args.ws ?? 'wss://streampolis.nutef.com/ws';
const WORKERS = (args.workers ?? 'https://streampolis.nutef.com/ws/1,https://streampolis.nutef.com/ws/2').split(',');
const CONTAINERS = (args.containers ?? 'streampolis_sp-game,streampolis_sp-game-2,streampolis_sp-api,streampolis_sp-game-gateway,streampolis_sp-db').split(',');
const PLAYERS = Number(args.players ?? 72);
const VIEWERS = Number(args.viewers ?? 100);
const SECONDS = Number(args.seconds ?? 180);
/**
 * 24 Hz porque é o que o cliente de verdade faz: `WorldConnection.update`
 * manda uma intenção por passo fixo, e o passo fixo é `TICK_HZ = 24`. Medir a
 * 10 Hz diria que o servidor aguenta um jogo que ninguém joga.
 */
const MOVE_HZ = Number(args.moveHz ?? 24);
const CHAT_PER_MIN = Number(args.chat ?? 60);
const SCENE = args.scene ?? 'central_plaza';
const RAMP_PER_SEC = Number(args.ramp ?? 12);
const OUT = args.out ?? 'shots/load/last.json';

const SECRET = process.env.SP_JWT_SECRET ?? process.env.JWT_SECRET ?? '';
if (!SECRET) {
  console.error('SP_JWT_SECRET ausente. `set -a && . /root/streampolis-deploy/.env && set +a` antes de rodar.');
  process.exit(2);
}

const ONLY = args.only ?? 'both';   // both | city | live
const STAMP = Date.now().toString(36).slice(-8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (t) => console.log(t);

/**
 * Sexta grandeza, descoberta na primeira rodada: erro de DECODIFICAÇÃO.
 *
 * O decodificador de schema do colyseus.js reclama em `console.error` quando
 * recebe um patch que se refere a um objeto que ele nunca viu ("refId not
 * found"). Isso não derruba o socket e não aparece em `onError` — o cliente
 * segue conectado com um mundo corrompido, que é o pior dos dois mundos e
 * exatamente o que um teste de carga tem de pegar. Sem este contador, a
 * primeira rodada teria sido declarada "0 erros".
 */
let fase = 'preparação';
const decodeErros = [];
const consoleErroOriginal = console.error;
console.error = (...partes) => {
  const texto = partes.map((p) => (typeof p === 'string' ? p : '')).join(' ');
  if (/refId|not found|Please report this issue/.test(texto)) {
    decodeErros.push({ fase, at: Date.now(), texto: texto.slice(0, 120) });
    return;   // engolido de propósito: 400 despejos de objeto afogam o relatório
  }
  consoleErroOriginal(...partes);
};

// ------------------------------------------------------------------ token ---

/**
 * Assina o mesmo JWT que a API assinaria (HS256, `iss: streampolis-api`).
 *
 * O game server nunca lê a tabela de usuários: ele confere assinatura, emissor
 * e validade, e tira nome e aparência das claims. Reproduzir isso aqui é o que
 * permite abrir 173 sessões sem passar pelo limitador de /auth.
 */
function assinaToken(userId, nome) {
  const agora = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    name: nome, perms: ['play'], gifterLevel: 0, agency: '',
    avatar: { bodyPreset: 0, skinTone: 3, facePreset: 0, hair: 'm_casual_character_head', hairColor: 1,
      top: 'm_casual_character_top', bottom: 'm_casual_character_bottom', shoes: 'm_casual_character_shoes',
      accessory: '', height: 1, body: 'v1' },
    sid: `lt_${STAMP}_${userId.slice(0, 8)}`,
    sub: userId, iss: 'streampolis-api', iat: agora, exp: agora + 3_600,
  })).toString('base64url');
  const assinatura = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${assinatura}`;
}

// ------------------------------------------------------------- amostragem ---

const bytes = (texto) => {
  const m = /^([\d.]+)\s*([kMGT]?i?B)$/.exec(texto.trim());
  if (!m) return 0;
  const escala = { B: 1, kB: 1e3, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824, TB: 1e12 };
  return Number(m[1]) * (escala[m[2]] ?? 1);
};

async function docker() {
  const { stdout } = await exec('docker', ['stats', '--no-stream', '--format',
    '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}']);
  const linhas = {};
  for (const linha of stdout.trim().split('\n')) {
    const [nome, cpu, mem, net] = linha.split('\t');
    // `startsWith` puro fazia `sp-game` engolir `sp-game-2` e o gateway: o
    // nome de uma tarefa do Swarm é `<serviço>.<réplica>.<id>`, e é o ponto que
    // separa o serviço do resto.
    const alvo = CONTAINERS.find((c) => nome.startsWith(`${c}.`));
    if (!alvo) continue;
    const [rx, tx] = net.split('/');
    linhas[alvo] = {
      cpuPerc: Number(cpu.replace('%', '')),
      memMB: Math.round(bytes(mem.split('/')[0]) / 1048576),
      rxBytes: bytes(rx), txBytes: bytes(tx),
    };
  }
  return linhas;
}

async function saudeDosWorkers(reset = false) {
  const leituras = {};
  await Promise.all(WORKERS.map(async (base) => {
    try {
      const res = await fetch(`${base}/health${reset ? '?reset=1' : ''}`, { signal: AbortSignal.timeout(8_000) });
      const body = await res.json();
      leituras[body.serverId ?? base] = { at: Date.now(), ...body };
    } catch (err) {
      leituras[base] = { erro: String(err?.message ?? err) };
    }
  }));
  return leituras;
}

const cargaDoHost = () => {
  const [um, cinco] = readFileSync('/proc/loadavg', 'utf8').split(' ');
  return { load1: Number(um), load5: Number(cinco) };
};

// ------------------------------------------------------------- populacao ---

async function contas(n) {
  const { stdout } = await exec('bash', ['-lc',
    `CID=$(docker ps --filter name=streampolis_sp-api -q | head -1); `
    + `source /root/streampolis-deploy/.env; `
    + `docker exec -w /app -e DATABASE_URL="postgres://streampolis:\${SP_DB_PASSWORD}@sp-db:5432/streampolis" `
    + `$CID node tools/load-users.mjs create --stamp=${STAMP} --n=${n}`],
    { maxBuffer: 8 * 1024 * 1024 });
  const dados = JSON.parse(stdout.trim().split('\n').pop());
  if (!dados.ok) throw new Error(`criação de contas falhou: ${dados.error}`);
  return dados.users.map((u) => ({ ...u, token: assinaToken(u.userId, u.username) }));
}

async function apagaContas() {
  const { stdout } = await exec('bash', ['-lc',
    `CID=$(docker ps --filter name=streampolis_sp-api -q | head -1); `
    + `source /root/streampolis-deploy/.env; `
    + `docker exec -w /app -e DATABASE_URL="postgres://streampolis:\${SP_DB_PASSWORD}@sp-db:5432/streampolis" `
    + `$CID node tools/load-users.mjs drop --stamp=${STAMP}`], { maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim().split('\n').pop());
}

// ---------------------------------------------------------------- clientes ---

const quedas = [];
const erros = [];
let encerrando = false;

/** Envolve uma sala para contar quem caiu sozinho — e só quem caiu sozinho. */
function vigia(sala, quem) {
  sala.onLeave((code) => {
    if (encerrando) return;
    quedas.push({ quem, code, at: Date.now() });
  });
  sala.onError((code, message) => erros.push({ quem, code, message }));
  // Handlers vazios: colyseus.js grita no console a cada mensagem sem dono, e
  // o grito esconderia um erro de verdade no meio de 173 clientes.
  for (const tipo of ['chatMessage', 'notice', 'giftEvent', 'stageInvite', 'pkResult', 'follow', 'presence']) {
    sala.onMessage(tipo, () => {});
  }
}

const espera = (label, cond, ms = 15_000) => new Promise((resolve) => {
  const fim = Date.now() + ms;
  const t = setInterval(() => {
    if (cond()) { clearInterval(t); resolve(true); }
    else if (Date.now() > fim) { clearInterval(t); console.log(`  … tempo esgotado: ${label}`); resolve(false); }
  }, 50);
});

async function main() {
  log(`\n═══ Teste de carga — ${PLAYERS} jogadores + live com ${VIEWERS} espectadores`);
  log(`    entrada ${WS} · janela de medição ${SECONDS}s · carimbo ${STAMP}`);

  const necessarias = PLAYERS + VIEWERS + 1;
  log(`\n1) Contas (${necessarias})`);
  const pessoas = await contas(necessarias);
  log(`  ✓ ${pessoas.length} contas criadas no banco da stack`);

  const anfitriao = pessoas[0];
  const espectadores = pessoas.slice(1, 1 + VIEWERS);
  const jogadores = pessoas.slice(1 + VIEWERS);

  log('\n2) Zerando os medidores dos workers');
  const zerado = await saudeDosWorkers(true);
  for (const [id, v] of Object.entries(zerado)) log(`  ✓ ${id}: rss ${v.metrics?.rssMB}MB, salas ${v.metrics?.rooms?.roomCount}, ccu ${v.metrics?.rooms?.ccu}`);
  const dockerAntes = await docker();

  const amostras = [];
  const amostrador = setInterval(async () => {
    try {
      amostras.push({ at: Date.now(), docker: await docker(), workers: await saudeDosWorkers(), host: cargaDoHost() });
    } catch { /* uma amostra perdida não invalida a série */ }
  }, 5_000);

  // ------------------------------------------------------------------ live ---
  fase = 'entrada da live';
  log(`\n3) Live: 1 anfitrião + ${VIEWERS} espectadores`);
  const clienteAnfitriao = ONLY === 'city' ? null : new Client(WS);
  const live = clienteAnfitriao && await clienteAnfitriao.create('live', {
    token: anfitriao.token, title: `Load test ${STAMP}`, category: 'música',
  });
  if (live) {
    vigia(live, 'host');
    await espera('a live existir', () => live.state?.liveId !== undefined);
    log(`  ✓ live ${live.roomId} aberta`);
  } else {
    log('  · pulada (--only=city)');
  }

  const salasDeEspectador = [];
  let recusasLive = 0;
  for (let i = 0; live && i < espectadores.length; i++) {
    try {
      const c = new Client(WS);
      const sala = await c.joinById(live.roomId, { token: espectadores[i].token });
      vigia(sala, `viewer${i}`);
      salasDeEspectador.push(sala);
    } catch (err) {
      recusasLive++;
      erros.push({ quem: `viewer${i}`, code: 'join', message: String(err?.message ?? err) });
    }
    if ((i + 1) % RAMP_PER_SEC === 0) await sleep(1_000);
  }
  log(`  ✓ ${salasDeEspectador.length}/${VIEWERS} espectadores dentro${recusasLive ? ` (${recusasLive} recusados)` : ''}`);
  if (live) {
    await espera('a sala contar a plateia', () => (live.state?.viewers ?? 0) >= salasDeEspectador.length - 2, 20_000);
    log(`  · a sala contabiliza ${live.state?.viewers} espectadores`);
  }

  // ----------------------------------------------------------------- cidade ---
  fase = 'entrada da cidade';
  log(`\n4) Cidade: ${PLAYERS} jogadores em ${SCENE}`);
  const salasDeJogador = [];
  let recusasCidade = 0;
  for (let i = 0; ONLY !== 'live' && i < jogadores.length; i++) {
    try {
      const c = new Client(WS);
      const sala = await c.joinOrCreate('city', { token: jogadores[i].token, sceneId: SCENE });
      vigia(sala, `player${i}`);
      salasDeJogador.push(sala);
    } catch (err) {
      recusasCidade++;
      erros.push({ quem: `player${i}`, code: 'join', message: String(err?.message ?? err) });
    }
    if ((i + 1) % RAMP_PER_SEC === 0) await sleep(1_000);
  }
  const shards = {};
  for (const sala of salasDeJogador) shards[sala.roomId] = (shards[sala.roomId] ?? 0) + 1;
  log(`  ✓ ${salasDeJogador.length}/${PLAYERS} jogadores dentro${recusasCidade ? ` (${recusasCidade} recusados)` : ''}`);
  log(`  · distribuição por shard: ${Object.entries(shards).map(([r, n]) => `${r}=${n}`).join(', ')}`);

  // ------------------------------------------------------------ estado firme ---
  log(`\n5) Regime: movimento a ${MOVE_HZ} Hz e ${CHAT_PER_MIN} mensagens/min na live, por ${SECONDS}s`);
  fase = 'regime';
  const inicioJanela = Date.now();
  const marcoWorkers = await saudeDosWorkers();
  const marcoDocker = await docker();

  let seq = 1;
  const rumos = salasDeJogador.map(() => Math.random() * Math.PI * 2);
  const movimento = setInterval(() => {
    seq++;
    for (let i = 0; i < salasDeJogador.length; i++) {
      // Rumo que muda devagar: andar em linha reta encostaria todo mundo na
      // borda em segundos, e uma praça com todos parados na cerca mede outra
      // coisa (nenhum vizinho perto, nenhum patch de AOI).
      if (seq % 40 === 0) rumos[i] += (Math.random() - 0.5) * 1.6;
      const dx = Math.sin(rumos[i]);
      const dz = Math.cos(rumos[i]);
      try {
        salasDeJogador[i].send('move', { dx, dz, yaw: Math.atan2(dx, dz), run: false, seq });
      } catch { /* socket caído já foi contado em quedas */ }
    }
  }, Math.round(1_000 / MOVE_HZ));

  let chatSeq = 0;
  const conversa = CHAT_PER_MIN > 0 ? setInterval(() => {
    const sala = salasDeEspectador[Math.floor(Math.random() * salasDeEspectador.length)];
    if (!sala) return;
    try { sala.send('chat', { text: `carga ${++chatSeq}` }); } catch { /* idem */ }
  }, Math.round(60_000 / CHAT_PER_MIN)) : null;

  await sleep(SECONDS * 1_000);
  clearInterval(movimento);
  if (conversa) clearInterval(conversa);

  const fimJanela = Date.now();
  const finalWorkers = await saudeDosWorkers();
  const finalDocker = await docker();
  clearInterval(amostrador);

  // ------------------------------------------------------------- relatório ---
  const janelaS = (fimJanela - inicioJanela) / 1_000;
  log(`\n6) Resultado (janela de ${janelaS.toFixed(0)}s)`);

  const porWorker = [];
  for (const [id, fim] of Object.entries(finalWorkers)) {
    const ini = marcoWorkers[id];
    if (!ini?.metrics || !fim?.metrics) continue;
    const cpuMs = (fim.metrics.cpuUserMs + fim.metrics.cpuSystemMs) - (ini.metrics.cpuUserMs + ini.metrics.cpuSystemMs);
    porWorker.push({
      worker: id,
      cpuPercDeUmNucleo: Math.round((cpuMs / (janelaS * 1_000)) * 1_000) / 10,
      rssMB: fim.metrics.rssMB,
      heapMB: fim.metrics.heapUsedMB,
      salas: fim.metrics.rooms?.roomCount,
      ccu: fim.metrics.rooms?.ccu,
      lagP50: fim.metrics.loopLagMs?.p50,
      lagP99: fim.metrics.loopLagMs?.p99,
      lagMax: fim.metrics.loopLagMs?.max,
    });
  }

  const banda = [];
  for (const nome of CONTAINERS) {
    const ini = marcoDocker[nome];
    const fim = finalDocker[nome];
    if (!ini || !fim) continue;
    banda.push({
      container: nome.replace('streampolis_', ''),
      rxKBps: Math.round(((fim.rxBytes - ini.rxBytes) / janelaS / 1024) * 10) / 10,
      txKBps: Math.round(((fim.txBytes - ini.txBytes) / janelaS / 1024) * 10) / 10,
      rxTotalMB: Math.round(((fim.rxBytes - ini.rxBytes) / 1048576) * 10) / 10,
      txTotalMB: Math.round(((fim.txBytes - ini.txBytes) / 1048576) * 10) / 10,
    });
  }

  console.table(porWorker);
  console.table(banda);
  const picoHost = amostras.reduce((m, a) => Math.max(m, a.host?.load1 ?? 0), 0);
  log(`  carga do host (contexto, inclui o próprio driver): pico load1 ${picoHost.toFixed(2)} em 8 núcleos`);
  log(`  quedas espontâneas: ${quedas.length}${quedas.length ? ` → ${JSON.stringify(quedas.slice(0, 5))}` : ''}`);
  const porFase = {};
  for (const e of decodeErros) porFase[e.fase] = (porFase[e.fase] ?? 0) + 1;
  log(`  erros de decodificação de estado no cliente: ${decodeErros.length} ${JSON.stringify(porFase)}`);
  log(`  erros: ${erros.length}${erros.length ? ` → ${JSON.stringify(erros.slice(0, 5))}` : ''}`);

  const relatorio = {
    stamp: STAMP, at: new Date().toISOString(),
    parametros: { ws: WS, players: PLAYERS, viewers: VIEWERS, seconds: SECONDS, moveHz: MOVE_HZ, chatPorMin: CHAT_PER_MIN },
    entrada: { jogadoresDentro: salasDeJogador.length, espectadoresDentro: salasDeEspectador.length, shards, recusasLive, recusasCidade },
    workers: porWorker, banda, quedas, erros, amostras, picoLoad1: picoHost,
    decodeErros: { total: decodeErros.length, porFase, exemplos: decodeErros.slice(0, 10) },
  };

  // ---------------------------------------------------------------- limpeza ---
  log('\n7) Desmontando');
  encerrando = true;
  await Promise.all([...salasDeJogador, ...salasDeEspectador].map((s) => s.leave().catch(() => {})));
  await live?.leave().catch(() => {});
  await sleep(2_000);
  const limpeza = await apagaContas();
  log(`  ✓ ${limpeza.removidos} contas de carga removidas do banco`);

  try {
    writeFileSync(OUT, JSON.stringify(relatorio, null, 2));
    log(`  ✓ relatório em ${OUT}`);
  } catch (err) {
    log(`  · não foi possível gravar ${OUT}: ${err.message}`);
  }
  process.exit(quedas.length > 0 || erros.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\n💥 teste de carga falhou:', err?.message ?? err);
  try { console.error(JSON.stringify(await apagaContas())); } catch { /* nada a fazer */ }
  process.exit(1);
});
