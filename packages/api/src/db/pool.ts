import pg from 'pg';
import { config } from '../config.ts';

/**
 * BIGINT (OID 20) chega como string no driver. Coins e Credits são inteiros que
 * cabem folgadamente em Number.MAX_SAFE_INTEGER, e string em conta é fonte de
 * bug silencioso ('100' + 1 === '1001'), então convertemos — e explodimos se um
 * dia passar do limite seguro em vez de arredondar em silêncio.
 */
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT fora do intervalo seguro de JS: ${value}`);
  }
  return n;
});

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export const pool: pg.Pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.poolMax,
  // search_path fixo por conexão: nenhuma query encosta no schema public.
  options: `-c search_path=${config.dbSchema},pg_catalog`,
  application_name: 'streampolis-api',
});

pool.on('error', (err: Error) => {
  console.error('[db] erro em cliente ocioso do pool:', err.message);
});

export async function closePool(): Promise<void> {
  await pool.end();
}
