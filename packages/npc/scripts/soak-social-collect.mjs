#!/usr/bin/env node
/**
 * Soak SOCIAL — coleta no banco de produção (roda dentro do container da API).
 * O que o relatório precisa e o cliente das personas não vê: cada chamada ao
 * modelo (propósito e hora — é o que diz se uma fala foi cumprimento, fala
 * ambiente ou "say" de deliberação), a memória episódica dos cognitivos, a
 * ficha (`npc_people`) de cada persona e as intenções da janela.
 *
 *   node scripts/soak-social-collect.mjs --since=ISO --until=ISO --users=id1,id2,...
 */
import pg from 'pg';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const since = new Date(args.since);
const until = args.until ? new Date(args.until) : new Date();
const users = (args.users ?? '').split(',').filter(Boolean);

const db = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=streampolis,pg_catalog' });
await db.connect();
const agents = (await db.query(`SELECT id, slug, display_name, scene_id FROM npc_agents WHERE kind = 'cognitive' ORDER BY slug`)).rows;
const out = { since: since.toISOString(), until: until.toISOString(), agents: [] };
for (const a of agents) {
  const calls = (await db.query(
    `SELECT purpose, tier, ok, error, latency_ms, created_at FROM npc_calls WHERE npc_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY id`, [a.id, since, until])).rows
    .map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
  const memory = (await db.query(
    `SELECT id, kind, user_id, user_name, text, created_at FROM npc_memory WHERE npc_id = $1 AND created_at >= $2 AND created_at <= $3 ORDER BY id`, [a.id, since, until])).rows
    .map((r) => ({ ...r, id: Number(r.id), created_at: r.created_at.toISOString() }));
  const people = users.length ? (await db.query(
    `SELECT user_id, user_name, first_seen, last_seen, encounters, exchanges, notes FROM npc_people WHERE npc_id = $1 AND user_id = ANY($2::uuid[])`, [a.id, users])).rows : [];
  const intentions = (await db.query(
    `SELECT id, goal, why, skill, params, source, trigger, planned_min, started_at, ended_at, outcome, exchanges, arrived, interactions, events, why_audit
       FROM npc_intentions WHERE npc_id = $1 AND started_at >= $2 AND started_at <= $3 ORDER BY id`, [a.id, since, until])).rows
    .map((r) => ({ ...r, id: Number(r.id) }));
  const persona = (await db.query(`SELECT version, status, created_at FROM npc_persona_versions WHERE npc_id = $1 ORDER BY version DESC LIMIT 1`, [a.id])).rows[0];
  out.agents.push({ id: a.id, slug: a.slug, name: a.display_name, scene: a.scene_id, calls, memory, people, intentions, persona });
}
out.otherHumans = (await db.query(
  `SELECT DISTINCT user_name FROM npc_people WHERE last_seen >= $1 AND NOT (user_id = ANY($2::uuid[]))`, [since, users.length ? users : ['00000000-0000-0000-0000-000000000000']])).rows.map((r) => r.user_name);
await db.end();
console.log(JSON.stringify(out));
