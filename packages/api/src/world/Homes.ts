import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';
import { HOME_BOUNDS, PLACEABLES, placementFits, placementsOverlap, type HomePlacement } from '../shared.ts';

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
  /**
   * Móveis colocados, COM posição. A versão anterior devolvia só os ids: o
   * banco guardava x/z/rotação desde sempre e a API jogava fora, então o
   * apartamento de todo mundo era idêntico por mais que se comprasse.
   */
  decor: HomePlacement[];
}

/**
 * Metade da largura/profundidade da planta, para validar colocação.
 *
 * Vem de `shared`, derivada do próprio desenho do apartamento: a medida
 * escrita à mão aqui descrevia uma sala que não existe (ver `HOME_BOUNDS`).
 */
export const ROOM_BOUNDS = HOME_BOUNDS;

interface HomeRow {
  id: string;
  owner_id: string;
  layout_id: string;
  visibility: HomeVisibility;
  owner_name: string | null;
  username: string;
}

async function decorOf(apartmentId: string): Promise<HomePlacement[]> {
  const { rows } = await pool.query<{ item_id: string; position: { x: number; z: number }; rotation: number }>(
    `SELECT i.item_id, pi.position, pi.rotation
       FROM property_items pi
       JOIN inventory i ON i.id = pi.item_instance_id
      WHERE pi.property_id = $1
      ORDER BY pi.placed_at`,
    [apartmentId],
  );
  return rows.map((r) => ({
    itemId: r.item_id,
    x: Number(r.position?.x ?? 0),
    z: Number(r.position?.z ?? 0),
    turn: ((Math.round(Number(r.rotation) || 0) % 4) + 4) % 4,
  }));
}

export interface LayoutRejection { reason: string; itemId?: string }

/**
 * Grava a planta do apartamento.
 *
 * A autoridade é aqui, não no navegador (SPECs §68): o cliente propõe uma
 * lista, a API confere posse de cada peça, se ela cabe na sala e se duas
 * ocupam o mesmo lugar. Um cliente que decide sozinho onde o sofá cabe é um
 * cliente que põe o sofá dentro da parede e afirma que pôs.
 */
export async function saveLayout(
  userId: string,
  apartmentId: string,
  placements: HomePlacement[],
): Promise<LayoutRejection | null> {
  if (placements.length > 120) return { reason: 'too_many' };

  for (const p of placements) {
    if (!PLACEABLES[p.itemId]) return { reason: 'not_placeable', itemId: p.itemId };
    if (!placementFits(p, ROOM_BOUNDS)) return { reason: 'out_of_bounds', itemId: p.itemId };
  }
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      if (placementsOverlap(placements[i], placements[j])) {
        return { reason: 'overlap', itemId: placements[i].itemId };
      }
    }
  }

  return withTransaction(async (client) => {
    const owns = await client.query<{ id: string; item_id: string }>(
      `SELECT id, item_id FROM inventory WHERE user_id = $1`,
      [userId],
    );
    // One inventory row is one physical object: two sofas placed means two
    // sofas owned. Spending the same instance twice is how a shop item becomes
    // free wallpaper.
    const free = new Map<string, string[]>();
    for (const row of owns.rows) {
      const list = free.get(row.item_id) ?? [];
      list.push(row.id);
      free.set(row.item_id, list);
    }
    const rows: Array<[string, HomePlacement]> = [];
    for (const p of placements) {
      const instance = free.get(p.itemId)?.pop();
      if (!instance) return { reason: 'not_owned', itemId: p.itemId };
      rows.push([instance, p]);
    }

    const mine = await client.query(
      'SELECT 1 FROM properties WHERE id = $1 AND owner_id = $2',
      [apartmentId, userId],
    );
    if (!mine.rowCount) return { reason: 'not_owner' };

    await client.query('DELETE FROM property_items WHERE property_id = $1', [apartmentId]);
    for (const [instance, p] of rows) {
      await client.query(
        `INSERT INTO property_items (property_id, item_instance_id, position, rotation)
         VALUES ($1, $2, $3, $4)`,
        [apartmentId, instance, JSON.stringify({ x: p.x, z: p.z }), p.turn],
      );
    }
    return null;
  });
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
