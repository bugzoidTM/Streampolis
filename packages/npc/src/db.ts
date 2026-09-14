import pg from 'pg';
import { config } from './config.js';

/**
 * As tabelas `npc_*` são do worker: ele escreve, a API só lê (painel) e
 * aciona as alavancas (ativar versão, desligar). Mesma disciplina de
 * `search_path` da API: nenhuma query encosta no schema `public`.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Dezenas de personagens num processo, mas quase todos mudos para o banco:
  // só os cognitivos escrevem a cada fala e os sociais gravam de 30 em 30 s.
  max: 6,
  options: `-c search_path=${config.dbSchema},pg_catalog`,
});

export async function closePool(): Promise<void> {
  await pool.end();
}
