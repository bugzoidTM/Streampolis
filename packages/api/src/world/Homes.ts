import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';

/**
 * Apartamentos (PRD §8).
 *
 * Existe para tirar do navegador a frase "este apartamento é meu e estes são os
 * móveis dele". A sala do game server passa a mandar só um id; dono, decoração
 * e privacidade saem daqui — do banco.
 */

export type HomeVisibility = 'open' | 'friends' | 'private';

export interface HomeSnapshot {
  apartmentId: string;
  ownerId: string;
  ownerName: string;
  layoutId: string;
  visibility: HomeVisibility;
  /** Ids de item colocados, na ordem em que foram postos. */
  decor: string[];
}

interface HomeRow {
  id: string;
  owner_id: string;
  layout_id: string;
  visibility: HomeVisibility;
  owner_name: string | null;
  username: string;
}

async function decorOf(apartmentId: string): Promise<string[]> {
  const { rows } = await pool.query<{ item_id: string }>(
    `SELECT i.item_id
       FROM property_items pi
       JOIN inventory i ON i.id = pi.item_instance_id
      WHERE pi.property_id = $1
      ORDER BY pi.placed_at`,
    [apartmentId],
  );
  return rows.map((r) => r.item_id);
}

export async function getHome(apartmentId: string): Promise<HomeSnapshot | null> {
  if (!/^[0-9a-f-]{36}$/i.test(apartmentId)) return null;
  const { rows } = await pool.query<HomeRow>(
    `SELECT p.id, p.owner_id, p.layout_id, p.visibility,
            pr.display_name AS owner_name, u.username
       FROM properties p
       JOIN users u     ON u.id = p.owner_id
       LEFT JOIN profiles pr ON pr.user_id = p.owner_id
      WHERE p.id = $1`,
    [apartmentId],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    apartmentId: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name || row.username,
    layoutId: row.layout_id,
    visibility: row.visibility,
    decor: await decorOf(row.id),
  };
}

/**
 * O apartamento do jogador, criado na primeira visita. Todo mundo tem casa
 * (PRD §8), então ausência aqui é estado inicial, não erro.
 */
export async function getOrCreateHomeOf(userId: string): Promise<HomeSnapshot> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM properties WHERE owner_id = $1 AND property_type = 'apartment'
      ORDER BY created_at LIMIT 1`,
    [userId],
  );

  const id = existing.rows[0]?.id ?? (await withTransaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO properties (owner_id, property_type, layout_id) VALUES ($1, 'apartment', 'studio_01')
       RETURNING id`,
      [userId],
    );
    return created.rows[0].id;
  }));

  const home = await getHome(id);
  if (!home) throw new Error(`apartamento ${id} sumiu logo após ser criado`);
  return home;
}

export async function setVisibility(userId: string, apartmentId: string, visibility: HomeVisibility): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE properties SET visibility = $3 WHERE id = $2 AND owner_id = $1',
    [userId, apartmentId, visibility],
  );
  return (rowCount ?? 0) > 0;
}

/** Quem pode entrar. `friends` exige amizade aceita (PRD §20). */
export async function canEnter(home: HomeSnapshot, visitorId: string): Promise<boolean> {
  if (home.ownerId === visitorId) return true;
  if (home.visibility === 'open') return true;
  if (home.visibility === 'private') return false;

  // A tabela guarda o par ORDENADO (user_a < user_b), então a consulta ordena
  // antes de perguntar em vez de testar as duas direções.
  const [a, b] = home.ownerId < visitorId ? [home.ownerId, visitorId] : [visitorId, home.ownerId];
  const { rowCount } = await pool.query(
    `SELECT 1 FROM friendships WHERE user_a = $1 AND user_b = $2 AND status = 'accepted' LIMIT 1`,
    [a, b],
  );
  return (rowCount ?? 0) > 0;
}
