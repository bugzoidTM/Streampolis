#!/usr/bin/env node
/**
 * Soak test de autonomia — COLETA (roda dentro do container da API, que
 * enxerga o banco de produção). Junta, para os personagens cognitivos, tudo
 * o que o relatório precisa: intenções (com resultado), chamadas ao modelo
 * por propósito, o que disseram (com a hora do mundo e o clima daquele
 * instante, recomputados pela fórmula compartilhada — determinística), com
 * quem falaram, diário e persona. Sai JSON no stdout.
 *
 *   node scripts/soak-collect.mjs --since=2026-09-15T00:58:00Z
 */
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const since = args.since ? new Date(args.since) : new Date(Date.now() - 10 * 3600_000);
const until = args.until ? new Date(args.until) : new Date();
const dayMinutes = Number(process.env.WORLD_DAY_MINUTES) || 120;
const forcedWeather = process.env.WORLD_WEATHER && process.env.WORLD_WEATHER !== 'auto' ? process.env.WORLD_WEATHER : undefined;

// ---- a mesma fórmula de shared/clock.ts e shared/weather.ts (sem importar TS daqui)
const EPOCH = Date.UTC(2026, 8, 14, 0, 0, 0);
const worldMinutes = (ms) => { const day = dayMinutes * 60_000; const ph = (((ms - EPOCH) % day) + day) % day; return (ph / day) * 1440; };
const fmt = (m) => { const mm = ((Math.floor(m) % 1440) + 1440) % 1440; return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`; };
const hash32 = (n) => { let x = (n ^ 0x9e3779b9) >>> 0; x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0; x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0; return (x ^ (x >>> 16)) >>> 0; };
const weatherAt = (ms) => forcedWeather ?? ((hash32(Math.floor(((ms - EPOCH) / (dayMinutes * 60_000)) * 1440 / 180)) % 1000) / 1000 < 0.3 ? 'rain' : 'clear');
const isNight = (m) => { const h = (((m % 1440) + 1440) % 1440) / 60; return h >= 19 || h < 6; };

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=streampolis,pg_catalog' });
await db.connect();

const agents = (await db.query(`SELECT id, slug, display_name, scene_id FROM npc_agents WHERE kind = 'cognitive' ORDER BY slug`)).rows;
const out = { since: since.toISOString(), until: until.toISOString(), dayMinutes, agents: [] };
for (const a of agents) {
  const intentions = (await db.query(
    `SELECT id, goal, why, skill, params, source, trigger, planned_min, started_at, ended_at, outcome, exchanges
       FROM npc_intentions WHERE npc_id = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY id`, [a.id, since, until])).rows;
  const calls = (await db.query(
    `SELECT purpose, tier, count(*)::int AS n, count(*) FILTER (WHERE NOT ok)::int AS failed, round(avg(latency_ms))::int AS avg_ms, max(latency_ms)::int AS max_ms
       FROM npc_calls WHERE npc_id = $1 AND created_at >= $2 AND created_at <= $3 GROUP BY purpose, tier ORDER BY n DESC`, [a.id, since, until])).rows;
  const callErrors = (await db.query(
    `SELECT purpose, error, count(*)::int AS n FROM npc_calls WHERE npc_id = $1 AND NOT ok AND created_at >= $2 AND created_at <= $3 GROUP BY purpose, error ORDER BY n DESC LIMIT 10`, [a.id, since, until])).rows;
  const said = (await db.query(
    `SELECT created_at, user_name, text FROM npc_memory WHERE npc_id = $1 AND kind = 'said' AND created_at >= $2 AND created_at <= $3 ORDER BY id`, [a.id, since, until])).rows
    .map((r) => ({ at: r.created_at.toISOString(), worldTime: fmt(worldMinutes(r.created_at.getTime())), night: isNight(worldMinutes(r.created_at.getTime())), weather: weatherAt(r.created_at.getTime()), to: r.user_name, text: r.text }));
  const heard = (await db.query(
    `SELECT created_at, user_name, text FROM npc_memory WHERE npc_id = $1 AND kind = 'heard' AND created_at >= $2 AND created_at <= $3 ORDER BY id`, [a.id, since, until])).rows
    .map((r) => ({ at: r.created_at.toISOString(), from: r.user_name, text: r.text }));
  const events = (await db.query(
    `SELECT created_at, text FROM npc_memory WHERE npc_id = $1 AND kind = 'event' AND created_at >= $2 AND created_at <= $3 ORDER BY id`, [a.id, since, until])).rows
    .map((r) => ({ at: r.created_at.toISOString(), text: r.text }));
  const people = (await db.query(
    `SELECT user_name, encounters, exchanges, notes, last_seen FROM npc_people WHERE npc_id = $1 AND last_seen >= $2 ORDER BY last_seen DESC`, [a.id, since])).rows;
  const diary = (await db.query(
    `SELECT created_at, entry, memories FROM npc_diary WHERE npc_id = $1 AND created_at >= $2 ORDER BY id`, [a.id, since])).rows;
  const persona = (await db.query(
    `SELECT version, source, status, created_at, persona FROM npc_persona_versions WHERE npc_id = $1 ORDER BY version DESC LIMIT 3`, [a.id])).rows;
  out.agents.push({ slug: a.slug, name: a.display_name, scene: a.scene_id, intentions, calls, callErrors, said, heard, events, people, diary, persona });
}
// Quem esteve na cidade no período (pessoas de verdade), para saber se havia com quem socializar.
out.humansSeen = (await db.query(
  `SELECT count(DISTINCT user_id)::int AS n FROM npc_people WHERE last_seen >= $1`, [since])).rows[0].n;
await db.end();
console.log(JSON.stringify(out));
