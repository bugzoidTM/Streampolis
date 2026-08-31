import { pool } from '../db/pool.ts';
import { withTransaction } from '../db/tx.ts';
import { EconomyError } from '../economy/errors.ts';
import { DEFAULT_AVATAR_DTO, type AvatarConfigDTO } from '../auth/identity.ts';

/**
 * Aparência do jogador (PRD §7).
 *
 * Esta é a única porta por onde um avatar muda. A regra que ela existe para
 * garantir: **vestir exige possuir**. Um item pago que o jogador não comprou é
 * recusado aqui, e como o game server só aceita a aparência que veio assinada
 * no token, não sobra caminho para "estou usando a roupa premium" pelo console.
 */

const SLOTS = {
  hair: 'hair',
  top: 'top',
  bottom: 'bottom',
  shoes: 'shoes',
  accessory: 'accessory',
} as const;

type Slot = keyof typeof SLOTS;

interface ItemRow {
  id: string;
  type: string;
  credits_price: number | null;
  coins_price: number | null;
  active: boolean;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function asId(value: unknown): string {
  return typeof value === 'string' && value.length <= 64 ? value : '';
}

/** Grátis = de graça nas duas moedas. Um item sem preço nenhum não é vestível. */
function isFree(item: ItemRow): boolean {
  return item.credits_price === 0 && (item.coins_price === null || item.coins_price === 0);
}

export interface AvatarValidation {
  config: AvatarConfigDTO;
  /** Itens recusados e o motivo, para a UI explicar em vez de sumir com a peça. */
  rejected: Array<{ slot: Slot; itemId: string; reason: 'unknown' | 'inactive' | 'wrong_slot' | 'not_owned' }>;
}

/**
 * Normaliza e valida um avatar contra catálogo e inventário. Não escreve nada:
 * é usada tanto pelo PUT quanto por qualquer conferência de leitura.
 */
export async function validateAvatar(userId: string, raw: unknown): Promise<AvatarValidation> {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const wanted: Record<Slot, string> = {
    hair: asId(input.hair),
    top: asId(input.top),
    bottom: asId(input.bottom),
    shoes: asId(input.shoes),
    accessory: asId(input.accessory),
  };

  const ids = Object.values(wanted).filter(Boolean);
  const catalog = new Map<string, ItemRow>();
  const owned = new Set<string>();

  if (ids.length > 0) {
    const items = await pool.query<ItemRow>(
      'SELECT id, type, credits_price, coins_price, active FROM items WHERE id = ANY($1::text[])',
      [ids],
    );
    for (const row of items.rows) catalog.set(row.id, row);

    const inventory = await pool.query<{ item_id: string }>(
      'SELECT item_id FROM inventory WHERE user_id = $1 AND item_id = ANY($2::text[]) AND quantity > 0',
      [userId, ids],
    );
    for (const row of inventory.rows) owned.add(row.item_id);
  }

  const rejected: AvatarValidation['rejected'] = [];
  const accepted: Record<Slot, string> = { hair: '', top: '', bottom: '', shoes: '', accessory: '' };

  for (const slot of Object.keys(wanted) as Slot[]) {
    const itemId = wanted[slot];
    if (!itemId) continue;
    const item = catalog.get(itemId);
    if (!item) { rejected.push({ slot, itemId, reason: 'unknown' }); continue; }
    if (!item.active) { rejected.push({ slot, itemId, reason: 'inactive' }); continue; }
    if (item.type !== SLOTS[slot]) { rejected.push({ slot, itemId, reason: 'wrong_slot' }); continue; }
    if (!isFree(item) && !owned.has(itemId)) {
      rejected.push({ slot, itemId, reason: 'not_owned' });
      continue;
    }
    accepted[slot] = itemId;
  }

  return {
    config: {
      bodyPreset: clampInt(input.bodyPreset, 0, 7, DEFAULT_AVATAR_DTO.bodyPreset),
      skinTone: clampInt(input.skinTone, 0, 15, DEFAULT_AVATAR_DTO.skinTone),
      facePreset: clampInt(input.facePreset, 0, 15, DEFAULT_AVATAR_DTO.facePreset),
      hairColor: clampInt(input.hairColor, 0, 15, DEFAULT_AVATAR_DTO.hairColor),
      hair: accepted.hair,
      top: accepted.top,
      bottom: accepted.bottom,
      shoes: accepted.shoes,
      accessory: accepted.accessory,
      // Altura é cosmética mas entra na física de câmera; fora da faixa vira
      // vantagem visual, então é presa no intervalo do PRD §7.
      height: Math.min(Math.max(typeof input.height === 'number' ? input.height : 1, 0.92), 1.08),
    },
    rejected,
  };
}

/**
 * Persiste a aparência. Recebe a validação já feita porque a rota precisa
 * RECUSAR antes de gravar: validar e salvar no mesmo passo grava a versão
 * podada do avatar e só depois responde 403, o que deixaria o jogador com a
 * peça sumida e um erro na tela.
 */
export async function saveAvatar(userId: string, validation: AvatarValidation): Promise<AvatarValidation> {
  await withTransaction(async (client) => {
    const updated = await client.query(
      'UPDATE avatars SET config = $2, updated_at = now() WHERE user_id = $1',
      [userId, JSON.stringify(validation.config)],
    );
    if (updated.rowCount === 0) {
      await client.query('INSERT INTO avatars (user_id, config) VALUES ($1, $2)', [
        userId,
        JSON.stringify(validation.config),
      ]);
    }
  });

  return validation;
}

export async function readAvatar(userId: string): Promise<AvatarConfigDTO> {
  const { rows } = await pool.query<{ config: AvatarConfigDTO }>(
    'SELECT config FROM avatars WHERE user_id = $1',
    [userId],
  );
  return rows[0]?.config ?? DEFAULT_AVATAR_DTO;
}

/** Usado pelas rotas: transforma recusa total em erro, não em avatar pelado. */
export function assertWearable(validation: AvatarValidation): void {
  const notOwned = validation.rejected.filter((r) => r.reason === 'not_owned');
  if (notOwned.length > 0) {
    throw new EconomyError(
      'ITEM_NOT_OWNED',
      `Item não pertence ao jogador: ${notOwned.map((r) => r.itemId).join(', ')}`,
      403,
    );
  }
}
