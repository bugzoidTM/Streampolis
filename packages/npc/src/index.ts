import { createServer } from 'node:http';
import { Brain } from './brain.js';
import { assertProductionConfig, config } from './config.js';
import { closePool, pool } from './db.js';
import { fetchIdentity, type NpcIdentity } from './identity.js';
import { budgetLeft, budgetUsed } from './llm.js';
import { log, warn } from './log.js';
import { loadActivePersona, type PersonaVersion } from './persona.js';
import { describeOutcome, reflect, unreflectedCount } from './reflect.js';
import type { SceneId } from './shared.js';
import { World } from './world.js';

/**
 * O processo do personagem. Um processo = um personagem = uma sala.
 *
 * O laço é simples de propósito:
 *
 *   - a cada 30 s: lê o freio de mão (`npc_enabled` + `npc_agents.enabled`),
 *     bate o coração no banco e, se a persona ativa mudou no painel, recarrega;
 *   - a cada 2 s: o tique da cabeça (andar, cumprimentar, fala ambiente);
 *   - a cada 60 s: pergunta se é hora de refletir;
 *   - ao cair: espera e volta, com token novo — o de sessão dura 15 min e a
 *     sala não renova no meio.
 *
 * `/health` responde na porta interna para o healthcheck do swarm.
 */

const TICK_MS = 2_000;
// Os dois abaixo aceitam ajuste por ambiente só para o e2e não esperar meio
// minuto por um freio de mão; em produção ficam no default.
const CONTROL_MS = Number(process.env.NPC_CONTROL_MS) || 30_000;
const REFLECT_CHECK_MS = Number(process.env.NPC_REFLECT_CHECK_MS) || 60_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 120_000;

interface Runtime {
  identity: NpcIdentity | null;
  world: World | null;
  brain: Brain | null;
  persona: PersonaVersion | null;
  enabled: boolean;
  reflecting: boolean;
  startedAt: number;
  lastError: string | null;
  reconnectDelay: number;
  reflections: number;
  lastReflection: string | null;
}

const rt: Runtime = {
  identity: null, world: null, brain: null, persona: null, enabled: true, reflecting: false,
  startedAt: Date.now(), lastError: null, reconnectDelay: RECONNECT_MIN_MS, reflections: 0, lastReflection: null,
};

async function readSwitch(): Promise<boolean> {
  try {
    const flag = await pool.query<{ enabled: boolean }>(`SELECT enabled FROM feature_flags WHERE key = 'npc_enabled'`);
    const agent = await pool.query<{ enabled: boolean }>(`SELECT enabled FROM npc_agents WHERE slug = $1`, [config.npcSlug]);
    const f = flag.rows[0]?.enabled ?? true;
    const a = agent.rows[0]?.enabled ?? false;
    return f && a;
  } catch (err) {
    // Banco fora: mantém o estado que tinha. Desligar por falha de leitura
    // faria o personagem sumir numa instabilidade qualquer.
    warn('main', 'não leu o freio de mão', { err: String(err) });
    return rt.enabled;
  }
}

async function heartbeat(): Promise<void> {
  if (!rt.identity) return;
  try {
    await pool.query(
      `UPDATE npc_agents SET last_heartbeat = now(), room_id = $2 WHERE id = $1`,
      [rt.identity.npc.id, rt.world?.roomId ?? null],
    );
  } catch (err) {
    warn('main', 'batimento falhou', { err: String(err) });
  }
}

async function reloadPersonaIfChanged(): Promise<void> {
  if (!rt.identity || !rt.brain) return;
  try {
    const active = await loadActivePersona(rt.identity.npc.id);
    if (active && active.version !== rt.brain.persona.version) {
      log('main', 'persona trocada no painel', { de: rt.brain.persona.version, para: active.version });
      rt.brain.persona = active;
      rt.persona = active;
    }
  } catch (err) {
    warn('main', 'não recarregou a persona', { err: String(err) });
  }
}

let connecting = false;

async function connect(): Promise<void> {
  if (connecting || !rt.enabled) return;
  connecting = true;
  try {
    const identity = await fetchIdentity();
    rt.identity = identity;
    const sceneId = identity.npc.sceneId as SceneId;
    const persona = rt.persona ?? await loadActivePersona(identity.npc.id);
    if (!persona) throw new Error('personagem sem persona ativa no banco');
    rt.persona = persona;

    // A cabeça sobrevive à reconexão: as conversas em andamento e os limites
    // por pessoa não zeram porque a rede piscou.
    const world = new World(sceneId, {
      chat: (m) => rt.brain?.onChat(m),
      appeared: (p) => rt.brain?.onAppeared(p),
      gone: (p) => rt.brain?.onGone(p),
      notice: (code, text) => rt.brain?.onNotice(code, text),
      disconnected: (code) => {
        rt.world = null;
        rt.lastError = `desconectado (${code})`;
        scheduleReconnect();
      },
    });
    if (!rt.brain) {
      rt.brain = new Brain({ id: identity.npc.id, name: identity.npc.displayName, sceneId }, world, persona);
    } else {
      rt.brain.persona = persona;
      rt.brain.rebind(world);
    }
    await world.join(identity.token);
    rt.world = world;
    rt.lastError = null;
    rt.reconnectDelay = RECONNECT_MIN_MS;
    await heartbeat();
  } catch (err) {
    rt.lastError = String(err);
    warn('main', 'não entrou na sala', { err: rt.lastError });
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer || !rt.enabled) return;
  const delay = rt.reconnectDelay;
  rt.reconnectDelay = Math.min(RECONNECT_MAX_MS, Math.round(rt.reconnectDelay * 1.8));
  log('main', 'tenta de novo em', { s: Math.round(delay / 1000) });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

async function control(): Promise<void> {
  const enabled = await readSwitch();
  if (enabled !== rt.enabled) {
    rt.enabled = enabled;
    log('main', enabled ? 'freio de mão SOLTO: entrando' : 'freio de mão PUXADO: saindo da sala');
    if (!enabled && rt.world) {
      const w = rt.world;
      rt.world = null;
      await w.leave();
    }
    if (enabled && !rt.world) void connect();
  }
  await heartbeat();
  await reloadPersonaIfChanged();
}

async function maybeReflect(): Promise<void> {
  if (!rt.identity || !rt.brain || !rt.enabled || rt.reflecting) return;
  try {
    const pending = await unreflectedCount(rt.identity.npc.id);
    if (!rt.brain.shouldReflect(pending)) return;
    rt.reflecting = true;
    log('reflect', 'começando', { pending, exchanges: rt.brain.exchangesSinceReflection });
    const outcome = await reflect({ id: rt.identity.npc.id, name: rt.identity.npc.displayName }, rt.brain.persona);
    rt.brain.lastReflectionAt = Date.now();
    rt.brain.exchangesSinceReflection = 0;
    rt.reflections++;
    rt.lastReflection = describeOutcome(outcome);
    if (outcome.persona) {
      rt.brain.persona = outcome.persona;
      rt.persona = outcome.persona;
    }
    log('reflect', 'terminou', { outcome: rt.lastReflection });
  } catch (err) {
    warn('reflect', 'falhou', { err: String(err) });
  } finally {
    rt.reflecting = false;
  }
}

function serveHealth(): void {
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const body = {
      ok: true,
      npc: rt.identity?.npc.slug ?? config.npcSlug,
      enabled: rt.enabled,
      connected: rt.world?.connected ?? false,
      room: rt.world?.roomId ?? null,
      position: rt.world?.position ?? null,
      personaVersion: rt.brain?.persona.version ?? null,
      brain: rt.brain?.status() ?? null,
      llm: { usedToday: budgetUsed(), leftToday: budgetLeft() },
      reflections: rt.reflections,
      lastReflection: rt.lastReflection,
      lastError: rt.lastError,
      uptimeSec: Math.round((Date.now() - rt.startedAt) / 1000),
    };
    // `ok` é "o processo vive". Estar fora da sala com o freio puxado não é
    // doença; estar fora com o freio solto por muito tempo é — e aparece em
    // `connected`/`lastError`, que é o que se lê no painel.
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  server.listen(config.healthPort, '0.0.0.0', () => log('main', 'health na porta', { port: config.healthPort }));
}

async function main(): Promise<void> {
  assertProductionConfig();
  log('main', 'subindo', { npc: config.npcSlug, game: config.gameServerUrl, api: config.apiBaseUrl });
  serveHealth();
  rt.enabled = await readSwitch();
  if (!rt.enabled) log('main', 'freio de mão puxado no boot: fico esperando');
  await connect();

  setInterval(() => rt.brain?.tick(), TICK_MS);
  setInterval(() => void control(), CONTROL_MS);
  setInterval(() => void maybeReflect(), REFLECT_CHECK_MS);

  const stop = async (signal: string) => {
    log('main', 'parando', { signal });
    rt.brain?.dispose();
    if (rt.world) await rt.world.leave();
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
