import { pool } from '../db/pool.ts';
import { DEFAULT_AVATAR_DTO, signSessionToken, type AvatarConfigDTO, type SessionToken } from '../auth/identity.ts';

/**
 * Personagens da cidade (PRD §25), do lado da API.
 *
 * A cabeça do personagem mora em `packages/npc`; aqui ficam as duas coisas que
 * só a API pode fazer: EMITIR a identidade dele (o game server só aceita token
 * assinado por ela) e mostrar ao painel o que ele anda pensando — persona,
 * memória, diário, custo — com o botão de reverter.
 *
 * A permissão `npc` no token é a marca inteira. Um usuário de verdade nunca a
 * recebe (`permissionsFor` não a conhece), então ninguém se fantasia de NPC;
 * e o game server desenha a placa a partir dela, então um NPC nunca passa por
 * jogador.
 */

export class NpcError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'NpcError';
  }
}

export interface NpcAgent {
  id: string;
  slug: string;
  displayName: string;
  sceneId: string;
  enabled: boolean;
  lastHeartbeat: string | null;
  roomId: string | null;
  online: boolean;
}

interface AgentRow {
  id: string;
  slug: string;
  display_name: string;
  avatar: unknown;
  scene_id: string;
  enabled: boolean;
  last_heartbeat: Date | null;
  room_id: string | null;
}

/** "Online" é batimento recente — o worker bate a cada 30 s. */
const ONLINE_WINDOW_MS = 90_000;

function toAgent(row: AgentRow): NpcAgent {
  const beat = row.last_heartbeat ? row.last_heartbeat.getTime() : 0;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    sceneId: row.scene_id,
    enabled: row.enabled,
    lastHeartbeat: row.last_heartbeat ? row.last_heartbeat.toISOString() : null,
    roomId: row.room_id,
    online: Date.now() - beat < ONLINE_WINDOW_MS,
  };
}

async function loadAgent(idOrSlug: string): Promise<AgentRow | null> {
  const bySlug = !/^[0-9a-f-]{36}$/i.test(idOrSlug);
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, slug, display_name, avatar, scene_id, enabled, last_heartbeat, room_id
       FROM npc_agents WHERE ${bySlug ? 'slug' : 'id'} = $1`,
    [idOrSlug],
  );
  return rows[0] ?? null;
}

/**
 * O token de sessão do personagem, para o worker entrar na sala.
 *
 * Mesmo emissor, mesmo segredo, mesma validade curta de um jogador — o game
 * server não tem um caminho especial para NPC, e é isso que garante que ele
 * passe pelos mesmos limites (chat, movimento, moderação) que todo mundo.
 */
export async function issueNpcToken(idOrSlug: string): Promise<SessionToken & { npc: NpcAgent }> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  if (!row.enabled) throw new NpcError('DISABLED', 'Personagem desativado.', 403);
  const avatar = await npcAvatar(row.avatar);
  const token = signSessionToken({
    userId: row.id,
    displayName: row.display_name,
    permissions: ['play', 'npc'],
    gifterLevel: 0,
    agency: '',
    avatar,
  });
  return { ...token, npc: toAgent(row) };
}

/**
 * A roupa do personagem, conferida contra o CATÁLOGO e não contra inventário.
 *
 * O validador dos jogadores (`validateAvatar`) recusa peça paga que a pessoa
 * não comprou — é a regra que impede vestir item de 5.000 Coins pelo console.
 * Um NPC não compra nada e ninguém além do banco define a roupa dele, então a
 * única conferência que faz sentido é "a peça existe e está ativa": um id que
 * saiu do catálogo viraria um corpo sem roupa na praça.
 */
async function npcAvatar(raw: unknown): Promise<AvatarConfigDTO> {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length <= 64 ? v : '');
  const int = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback);
  const wanted = { hair: str(input.hair), top: str(input.top), bottom: str(input.bottom), shoes: str(input.shoes), accessory: str(input.accessory) };
  const ids = Object.values(wanted).filter(Boolean);
  const active = new Set<string>();
  if (ids.length > 0) {
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM items WHERE active AND id = ANY($1::text[])', [ids],
    );
    for (const r of rows) active.add(r.id);
  }
  const slot = (key: keyof typeof wanted) => (wanted[key] && active.has(wanted[key]) ? wanted[key] : DEFAULT_AVATAR_DTO[key]);
  return {
    bodyPreset: int(input.bodyPreset, DEFAULT_AVATAR_DTO.bodyPreset),
    skinTone: int(input.skinTone, DEFAULT_AVATAR_DTO.skinTone),
    facePreset: int(input.facePreset, DEFAULT_AVATAR_DTO.facePreset),
    hair: slot('hair'),
    hairColor: int(input.hairColor, DEFAULT_AVATAR_DTO.hairColor),
    top: slot('top'),
    bottom: slot('bottom'),
    shoes: slot('shoes'),
    accessory: wanted.accessory && active.has(wanted.accessory) ? wanted.accessory : '',
    height: typeof input.height === 'number' && Number.isFinite(input.height)
      ? Math.min(Math.max(input.height, 0.92), 1.08)
      : DEFAULT_AVATAR_DTO.height,
    body: 'v1',
  };
}

// --------------------------------------------------------------- painel ---

export async function listAgents(): Promise<NpcAgent[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, slug, display_name, avatar, scene_id, enabled, last_heartbeat, room_id
       FROM npc_agents ORDER BY created_at`,
  );
  return rows.map(toAgent);
}

export interface NpcOverview {
  agent: NpcAgent;
  persona: { version: number; source: string; createdAt: string; persona: unknown } | null;
  pendingVersions: number;
  memories: number;
  people: number;
  diaryEntries: number;
  lastDiaryAt: string | null;
  callsToday: { total: number; failed: number; avgLatencyMs: number | null };
}

export async function overview(idOrSlug: string): Promise<NpcOverview> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const id = row.id;
  const [persona, pending, memories, people, diary, calls] = await Promise.all([
    pool.query<{ version: number; source: string; created_at: Date; persona: unknown }>(
      `SELECT version, source, created_at, persona FROM npc_persona_versions
        WHERE npc_id = $1 AND status = 'active'`, [id]),
    pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM npc_persona_versions WHERE npc_id = $1 AND status = 'pending'`, [id]),
    pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM npc_memory WHERE npc_id = $1`, [id]),
    pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM npc_people WHERE npc_id = $1`, [id]),
    pool.query<{ n: string; last: Date | null }>(
      `SELECT count(*)::text AS n, max(created_at) AS last FROM npc_diary WHERE npc_id = $1`, [id]),
    pool.query<{ total: string; failed: string; avg: string | null }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE NOT ok)::text AS failed,
              round(avg(latency_ms))::text AS avg
         FROM npc_calls WHERE npc_id = $1 AND created_at >= date_trunc('day', now())`, [id]),
  ]);
  const p = persona.rows[0];
  const c = calls.rows[0];
  return {
    agent: toAgent(row),
    persona: p ? { version: p.version, source: p.source, createdAt: p.created_at.toISOString(), persona: p.persona } : null,
    pendingVersions: Number(pending.rows[0]?.n ?? 0),
    memories: Number(memories.rows[0]?.n ?? 0),
    people: Number(people.rows[0]?.n ?? 0),
    diaryEntries: Number(diary.rows[0]?.n ?? 0),
    lastDiaryAt: diary.rows[0]?.last ? diary.rows[0].last.toISOString() : null,
    callsToday: {
      total: Number(c?.total ?? 0),
      failed: Number(c?.failed ?? 0),
      avgLatencyMs: c?.avg ? Number(c.avg) : null,
    },
  };
}

export interface PersonaVersion {
  version: number;
  source: string;
  status: string;
  audit: unknown;
  basedOnDiary: number | null;
  createdAt: string;
  activatedAt: string | null;
  persona: unknown;
}

export async function listPersonaVersions(idOrSlug: string): Promise<PersonaVersion[]> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const { rows } = await pool.query<{
    version: number; source: string; status: string; audit: unknown; based_on_diary: string | null;
    created_at: Date; activated_at: Date | null; persona: unknown;
  }>(
    `SELECT version, source, status, audit, based_on_diary, created_at, activated_at, persona
       FROM npc_persona_versions WHERE npc_id = $1 ORDER BY version DESC LIMIT 100`,
    [row.id],
  );
  return rows.map((r) => ({
    version: r.version,
    source: r.source,
    status: r.status,
    audit: r.audit,
    basedOnDiary: r.based_on_diary ? Number(r.based_on_diary) : null,
    createdAt: r.created_at.toISOString(),
    activatedAt: r.activated_at ? r.activated_at.toISOString() : null,
    persona: r.persona,
  }));
}

/**
 * Ativar uma versão: aprovar uma pendente OU reverter para uma antiga — é a
 * mesma operação, e é a única forma de mudar a persona pelo painel. A ativa
 * de agora vira `retired`; o worker recarrega a persona no próximo minuto.
 */
export async function activatePersona(idOrSlug: string, version: number, actorId: string): Promise<PersonaVersion> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM npc_persona_versions WHERE npc_id = $1 AND version = $2 FOR UPDATE`,
      [row.id, version],
    );
    const t = target.rows[0];
    if (!t) throw new NpcError('NOT_FOUND', 'Versão não existe.', 404);
    if (t.status === 'active') throw new NpcError('ALREADY_ACTIVE', 'Esta versão já está no ar.', 409);
    await client.query(
      `UPDATE npc_persona_versions SET status = 'retired' WHERE npc_id = $1 AND status = 'active'`,
      [row.id],
    );
    await client.query(
      `UPDATE npc_persona_versions
          SET status = 'active', activated_at = now(), activated_by = $2
        WHERE id = $1`,
      [t.id, actorId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const all = await listPersonaVersions(row.id);
  const v = all.find((x) => x.version === version);
  if (!v) throw new NpcError('NOT_FOUND', 'Versão não existe.', 404);
  return v;
}

export async function rejectPersona(idOrSlug: string, version: number): Promise<void> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const { rowCount } = await pool.query(
    `UPDATE npc_persona_versions SET status = 'rejected'
      WHERE npc_id = $1 AND version = $2 AND status = 'pending'`,
    [row.id, version],
  );
  if (!rowCount) throw new NpcError('NOT_PENDING', 'Só uma versão pendente pode ser recusada.', 409);
}

export async function setAgentEnabled(idOrSlug: string, enabled: boolean): Promise<NpcAgent> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  await pool.query(`UPDATE npc_agents SET enabled = $2 WHERE id = $1`, [row.id, enabled]);
  const after = await loadAgent(row.id);
  return toAgent(after ?? row);
}

export async function recentMemory(idOrSlug: string, limit: number): Promise<unknown[]> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const { rows } = await pool.query(
    `SELECT id, kind, user_id, user_name, text, room_id, reflected, created_at
       FROM npc_memory WHERE npc_id = $1 ORDER BY id DESC LIMIT $2`,
    [row.id, Math.max(1, Math.min(limit, 500))],
  );
  return rows;
}

export async function diary(idOrSlug: string, limit: number): Promise<unknown[]> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const { rows } = await pool.query(
    `SELECT id, entry, memories, created_at FROM npc_diary
      WHERE npc_id = $1 ORDER BY id DESC LIMIT $2`,
    [row.id, Math.max(1, Math.min(limit, 200))],
  );
  return rows;
}

export async function people(idOrSlug: string, limit: number): Promise<unknown[]> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const { rows } = await pool.query(
    `SELECT user_id, user_name, first_seen, last_seen, encounters, exchanges, notes
       FROM npc_people WHERE npc_id = $1 ORDER BY last_seen DESC LIMIT $2`,
    [row.id, Math.max(1, Math.min(limit, 500))],
  );
  return rows;
}

export async function calls(idOrSlug: string, limit: number): Promise<unknown[]> {
  const row = await loadAgent(idOrSlug);
  if (!row) throw new NpcError('NOT_FOUND', 'Personagem não existe.', 404);
  const { rows } = await pool.query(
    `SELECT id, tier, purpose, model, ok, error, latency_ms, prompt_chars, reply_chars, created_at
       FROM npc_calls WHERE npc_id = $1 ORDER BY id DESC LIMIT $2`,
    [row.id, Math.max(1, Math.min(limit, 500))],
  );
  return rows;
}
