import type { PoolClient } from './pool.ts';
import { pool } from './pool.ts';

export type Executor = Pick<PoolClient, 'query'>;

/**
 * Abre transação, roda `fn`, comita. Qualquer throw faz ROLLBACK.
 *
 * Toda operação de economia passa por aqui — nenhuma escrita de carteira roda
 * em autocommit (SPECs §25).
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(
      opts.isolation
        ? `BEGIN ISOLATION LEVEL ${opts.isolation.toUpperCase()}`
        : 'BEGIN',
    );
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Código do Postgres para violação de unicidade. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  if (e.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || e.constraint === constraint;
}
