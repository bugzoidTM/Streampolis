import { createServer } from 'node:http';
import { AmbientMind } from './ambient.js';
import { Brain } from './brain.js';
import { assertProductionConfig, config } from './config.js';
import { closePool, pool } from './db.js';
import { fetchIdentity, type NpcIdentity } from './identity.js';
import { budgetLeft, budgetUsed } from './llm.js';
import { log, warn } from './log.js';
import type { Mind } from './mind.js';
import { loadActivePersona, type PersonaVersion } from './persona.js';
import { describeOutcome, reflect, unreflectedCount } from './reflect.js';
import { kindEnabled, loadRoster, readFlags, type AgentRow, type AmbientProfile, type NpcKind, type SocialProfile } from './roster.js';
import { SocialMind } from './social.js';
import { World } from './world.js';

/**
 * O processo dos personagens. Um processo = o elenco inteiro (ou a fatia
 * dele que `NPC_SLUGS` pedir); cada personagem é um cliente Colyseus com o
 * seu corpo e a sua cabeça — cognitiva (LLM), social (caixa) ou ambiente
 * (rotina). Ver `mind.ts`.
 *
 * O laço:
 *
 *   - a cada 30 s: relê os freios (`npc_enabled` e os por classe) e o elenco
 *     do banco; quem entrou/ligou começa (escalonado, um a cada 400 ms — 77
 *     entradas de uma vez são uma rajada no matchmaking), quem saiu/desligou
 *     deixa a sala; bate o coração de todos numa query; recarrega a persona
 *     dos cognitivos se mudou no painel;
 *   - a cada 2 s: o tique de todas as cabeças;
 *   - a cada 60 s: os cognitivos perguntam se é hora de refletir;
 *   - ao cair: cada corpo espera e volta, com token novo.
 *
 * `/health` responde na porta interna com o resumo de todos.
 */

const TICK_MS = 2_000;
const CONTROL_MS = Number(process.env.NPC_CONTROL_MS) || 30_000;
const REFLECT_CHECK_MS = Number(process.env.NPC_REFLECT_CHECK_MS) || 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;
const JOIN_STAGGER_MS = Number(process.env.NPC_JOIN_STAGGER_MS) || 400;

interface Agent {
  row: AgentRow;
  identity: NpcIdentity | null;
  world: World | null;
  mind: Mind | null;
  persona: PersonaVersion | null;
  wanted: boolean;
  connecting: boolean;
  reflecting: boolean;
  reconnectDelay: number;
  reconnectTimer: NodeJS.Timeout | null;
  lastError: string | null;
  reflections: number;
  lastReflection: string | null;
}

const agents = new Map<string, Agent>();
let flags: Record<string, boolean> = { npc_enabled: true, npc_ambient_enabled: true, npc_social_enabled: true };
const startedAt = Date.now();

/** Quais slugs este processo hospeda. Vazio = todos os habilitados. `NPC_SLUG` (singular) continua valendo. */
function wantedSlugs(): Set<string> | null {
  const raw = (process.env.NPC_SLUGS ?? '').trim() || (process.env.NPC_SLUG ?? '').trim();
  if (!raw || raw === '*') return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

function buildMind(row: AgentRow, world: World, persona: PersonaVersion | null): Mind {
  const npc = { id: row.id, name: row.displayName, sceneId: row.sceneId };
  if (row.kind === 'ambient') return new AmbientMind(npc, world, row.profile as AmbientProfile);
  if (row.kind === 'social') return new SocialMind(npc, world, row.profile as SocialProfile);
  if (!persona) throw new Error('personagem cognitivo sem persona ativa no banco');
  return new Brain(npc, world, persona);
}

// ---------------------------------------------------------------- entrada

const joinQueue: Agent[] = [];
let joinTimer: NodeJS.Timeout | null = null;

function enqueueJoin(agent: Agent): void {
  if (joinQueue.includes(agent)) return;
  joinQueue.push(agent);
  if (!joinTimer) drainJoins();
}

function drainJoins(): void {
  const next = joinQueue.shift();
  if (!next) { joinTimer = null; return; }
  void connect(next);
  joinTimer = setTimeout(drainJoins, JOIN_STAGGER_MS);
}

async function connect(agent: Agent): Promise<void> {
  if (agent.connecting || !agent.wanted || agent.world) return;
  agent.connecting = true;
  try {
    const identity = await fetchIdentity(agent.row.slug);
    agent.identity = identity;
    if (agent.row.kind === 'cognitive' && !agent.persona) {
      agent.persona = await loadActivePersona(agent.row.id);
    }
    const world = new World(agent.row.sceneId, {
      chat: (m) => agent.mind?.onChat(m),
      appeared: (p) => agent.mind?.onAppeared(p),
      gone: (p) => agent.mind?.onGone(p),
      notice: (code, text) => agent.mind?.onNotice(code, text),
      disconnected: (code) => {
        agent.world = null;
        agent.lastError = `desconectado (${code})`;
        scheduleReconnect(agent);
      },
    });
    // A cabeça sobrevive à reconexão: conversas, relações e limites não zeram
    // porque a rede piscou.
    if (!agent.mind) agent.mind = buildMind(agent.row, world, agent.persona);
    else agent.mind.rebind(world);
    await world.join(identity.token);
    agent.world = world;
    agent.lastError = null;
    agent.reconnectDelay = RECONNECT_MIN_MS;
  } catch (err) {
    agent.lastError = String(err);
    warn('main', 'não entrou na sala', { npc: agent.row.slug, err: agent.lastError });
    scheduleReconnect(agent);
  } finally {
    agent.connecting = false;
  }
}

function scheduleReconnect(agent: Agent): void {
  if (agent.reconnectTimer || !agent.wanted) return;
  const delay = agent.reconnectDelay;
  agent.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(agent.reconnectDelay * 1.8));
  agent.reconnectTimer = setTimeout(() => {
    agent.reconnectTimer = null;
    enqueueJoin(agent);
  }, delay);
}

async function stopAgent(agent: Agent, reason: string): Promise<void> {
  agent.wanted = false;
  if (agent.reconnectTimer) { clearTimeout(agent.reconnectTimer); agent.reconnectTimer = null; }
  const i = joinQueue.indexOf(agent);
  if (i >= 0) joinQueue.splice(i, 1);
  const w = agent.world;
  agent.world = null;
  if (w) await w.leave();
  log('main', 'saiu', { npc: agent.row.slug, reason });
}

// --------------------------------------------------------------- controle

async function control(): Promise<void> {
  flags = await readFlags(flags);
  let rows: AgentRow[];
  try {
    rows = await loadRoster();
  } catch (err) {
    warn('main', 'não leu o elenco; mantém o que tinha', { err: String(err) });
    rows = [...agents.values()].map((a) => a.row);
  }
  const only = wantedSlugs();
  const seen = new Set<string>();
  for (const row of rows) {
    if (only && !only.has(row.slug)) continue;
    seen.add(row.id);
    const want = row.enabled && kindEnabled(row.kind, flags);
    let agent = agents.get(row.id);
    if (!agent) {
      agent = {
        row, identity: null, world: null, mind: null, persona: null, wanted: false, connecting: false, reflecting: false,
        reconnectDelay: RECONNECT_MIN_MS, reconnectTimer: null, lastError: null, reflections: 0, lastReflection: null,
      };
      agents.set(row.id, agent);
    } else {
      agent.row = row;
    }
    if (want && !agent.wanted) {
      agent.wanted = true;
      log('main', 'entrando', { npc: row.slug, kind: row.kind, scene: row.sceneId });
      enqueueJoin(agent);
    } else if (!want && agent.wanted) {
      await stopAgent(agent, row.enabled ? `freio ${row.kind}` : 'desligado no banco');
    }
  }
  for (const [id, agent] of [...agents]) {
    if (seen.has(id)) continue;
    await stopAgent(agent, 'saiu do elenco');
    await agent.mind?.flush?.().catch(() => {});
    agent.mind?.dispose();
    agents.delete(id);
  }
  await heartbeat();
  await reloadPersonas();
}

async function heartbeat(): Promise<void> {
  const online = [...agents.values()].filter((a) => a.world);
  if (!online.length) return;
  try {
    await pool.query(
      `UPDATE npc_agents AS a SET last_heartbeat = now(), room_id = v.room_id
         FROM unnest($1::uuid[], $2::text[]) AS v(id, room_id) WHERE a.id = v.id`,
      [online.map((a) => a.row.id), online.map((a) => a.world?.roomId ?? null)],
    );
  } catch (err) {
    warn('main', 'batimento falhou', { err: String(err) });
  }
}

async function reloadPersonas(): Promise<void> {
  for (const agent of agents.values()) {
    if (agent.row.kind !== 'cognitive' || !(agent.mind instanceof Brain)) continue;
    try {
      const active = await loadActivePersona(agent.row.id);
      if (active && active.version !== agent.mind.persona.version) {
        log('main', 'persona trocada no painel', { npc: agent.row.slug, de: agent.mind.persona.version, para: active.version });
        agent.mind.persona = active;
        agent.persona = active;
      }
    } catch (err) {
      warn('main', 'não recarregou a persona', { npc: agent.row.slug, err: String(err) });
    }
  }
}

async function maybeReflect(agent: Agent): Promise<void> {
  const brain = agent.mind;
  if (!(brain instanceof Brain) || !agent.wanted || agent.reflecting) return;
  try {
    const pending = await unreflectedCount(agent.row.id);
    if (!brain.shouldReflect(pending)) return;
    agent.reflecting = true;
    log('reflect', 'começando', { npc: agent.row.slug, pending, exchanges: brain.exchangesSinceReflection });
    const outcome = await reflect({ id: agent.row.id, name: agent.row.displayName }, brain.persona);
    brain.lastReflectionAt = Date.now();
    brain.exchangesSinceReflection = 0;
    agent.reflections++;
    agent.lastReflection = describeOutcome(outcome);
    if (outcome.persona) {
      brain.persona = outcome.persona;
      agent.persona = outcome.persona;
    }
    log('reflect', 'terminou', { npc: agent.row.slug, outcome: agent.lastReflection });
  } catch (err) {
    warn('reflect', 'falhou', { npc: agent.row.slug, err: String(err) });
  } finally {
    agent.reflecting = false;
  }
}

// ----------------------------------------------------------------- saúde

function summary(): Record<string, unknown> {
  const byKind: Record<NpcKind, { wanted: number; connected: number }> = {
    cognitive: { wanted: 0, connected: 0 }, social: { wanted: 0, connected: 0 }, ambient: { wanted: 0, connected: 0 },
  };
  const list = [...agents.values()].map((a) => {
    if (a.wanted) byKind[a.row.kind].wanted++;
    if (a.world) byKind[a.row.kind].connected++;
    return {
      npc: a.row.slug, kind: a.row.kind, scene: a.row.sceneId, wanted: a.wanted, connected: a.world?.connected ?? false,
      room: a.world?.roomId ?? null, position: a.world?.position ?? null,
      personaVersion: a.mind instanceof Brain ? a.mind.persona.version : undefined,
      mind: a.mind?.status() ?? null, lastError: a.lastError,
      reflections: a.row.kind === 'cognitive' ? a.reflections : undefined,
      lastReflection: a.row.kind === 'cognitive' ? a.lastReflection : undefined,
    };
  });
  const first = list.find((a) => a.kind === 'cognitive') ?? list[0];
  return {
    ok: true,
    // Campos do formato antigo (um personagem por processo), para quem já lia o /health do Nilo.
    npc: first?.npc ?? null,
    enabled: flags.npc_enabled !== false,
    connected: first?.connected ?? false,
    room: first?.room ?? null,
    position: first?.position ?? null,
    personaVersion: first?.personaVersion ?? null,
    brain: first?.mind ?? null,
    reflections: first?.reflections ?? 0,
    lastReflection: first?.lastReflection ?? null,
    lastError: first?.lastError ?? null,
    flags,
    byKind,
    agents: list,
    llm: { usedToday: budgetUsed(), leftToday: budgetLeft() },
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  };
}

function serveHealth(): void {
  const server = createServer((req, res) => {
    if (req.url !== '/health') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(summary()));
  });
  server.listen(config.healthPort, '0.0.0.0', () => log('main', 'health na porta', { port: config.healthPort }));
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  assertProductionConfig();
  log('main', 'subindo', { slugs: [...(wantedSlugs() ?? ['*'])], game: config.gameServerUrl, api: config.apiBaseUrl });
  serveHealth();
  await control();

  setInterval(() => { for (const a of agents.values()) if (a.world) a.mind?.tick(); }, TICK_MS);
  setInterval(() => void control(), CONTROL_MS);
  setInterval(() => { for (const a of agents.values()) void maybeReflect(a); }, REFLECT_CHECK_MS);

  const stop = async (signal: string) => {
    log('main', 'parando', { signal });
    for (const a of agents.values()) {
      a.mind?.dispose();
      if (a.world) await a.world.leave();
    }
    // As relações sujas vão ao banco antes de o pool fechar — um flush
    // disparado e esquecido dentro do dispose perdia a corrida com o `end()`.
    for (const a of agents.values()) await a.mind?.flush?.().catch(() => {});
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  console.error('[npc] não subiu:', err);
  process.exit(1);
});
