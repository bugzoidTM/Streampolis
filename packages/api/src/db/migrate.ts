/**
 * Runner de migrations em SQL puro. Sem ORM: nada esconde a transação.
 *
 * Cada arquivo roda dentro de UMA transação e é registrado com o sha-256 do
 * conteúdo. Editar um arquivo já aplicado é erro — migration aplicada é
 * histórico, não rascunho.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.ts';
import { config } from '../config.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface AppliedMigration {
  name: string;
  checksum: string;
}

async function ensureBookkeeping(): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(config.dbSchema)}`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(config.dbSchema)}.schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function quoteIdent(ident: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new Error(`Identificador de schema inválido: ${ident}`);
  }
  return `"${ident}"`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export async function runMigrations(
  log: (msg: string) => void = console.log,
): Promise<string[]> {
  await ensureBookkeeping();
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<AppliedMigration>(
    `SELECT name, checksum FROM ${quoteIdent(config.dbSchema)}.schema_migrations`,
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const executed: string[] = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha256(sql);
    const previous = applied.get(file);

    if (previous !== undefined) {
      // 0005_seed é idempotente por natureza (ON CONFLICT DO UPDATE) e muda
      // quando o catálogo muda: reaplicamos em vez de travar.
      if (previous !== checksum) {
        if (file.includes('seed')) {
          await applyFile(file, sql, checksum, log, true);
          executed.push(file);
          continue;
        }
        throw new Error(
          `Migration ${file} já aplicada foi alterada (checksum diferente). ` +
            'Crie um novo arquivo em vez de editar o histórico.',
        );
      }
      continue;
    }

    await applyFile(file, sql, checksum, log, false);
    executed.push(file);
  }

  if (executed.length === 0) log('[migrate] nada a aplicar');
  return executed;
}

async function applyFile(
  file: string,
  sql: string,
  checksum: string,
  log: (msg: string) => void,
  reapply: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO ${quoteIdent(config.dbSchema)}, pg_catalog`);
    await client.query(sql);
    await client.query(
      `INSERT INTO ${quoteIdent(config.dbSchema)}.schema_migrations (name, checksum)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
      [file, checksum],
    );
    await client.query('COMMIT');
    log(`[migrate] ${reapply ? 'reaplicado' : 'aplicado'} ${file}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`Falha em ${file}: ${(err as Error).message}`, { cause: err });
  } finally {
    client.release();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err: Error) => {
      console.error('[migrate] ERRO:', err.message);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
