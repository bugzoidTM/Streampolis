import pg from 'pg';
import { config } from './config.js';

/**
 * As tabelas `npc_*` são do worker: ele escreve, a API só lê (painel) e
 * aciona as alavancas (ativar versão, desligar). Mesma disciplina de
 * `search_path` da API: nenhuma query encosta no schema `public`.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  options: `-c search_path=${config.dbSchema},pg_catalog`,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
