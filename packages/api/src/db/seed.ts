/**
 * Seed de desenvolvimento.
 *
 * Os catálogos (gifts, itens, pacotes, flags) já vêm da migration 0005 — quem
 * cobra é o banco, e o preço não pode depender de um script ter rodado. O que
 * este arquivo cria são as CONTAS de desenvolvimento que o game server e o
 * cliente usam para entrar no mundo antes do cadastro existir.
 *
 *   node --env-file-if-exists=.env src/db/seed.ts
 *
 * Recusa-se a rodar em produção: contas com senha conhecida não têm nada que
 * fazer lá.
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.ts';
import { pool, closePool } from './pool.ts';
import { withTransaction } from '../db/tx.ts';
import { DEFAULT_AVATAR_DTO } from '../auth/identity.ts';

interface DevUser {
  username: string;
  email: string;
  coins: number;
  credits: number;
  role: 'player' | 'moderator' | 'admin';
}

const DEV_PASSWORD = 'streampolis-dev';

const DEV_USERS: DevUser[] = [
  { username: 'ana', email: 'ana@dev.streampolis', coins: 50_000, credits: 20_000, role: 'player' },
  { username: 'beto', email: 'beto@dev.streampolis', coins: 50_000, credits: 20_000, role: 'player' },
  { username: 'caio', email: 'caio@dev.streampolis', coins: 5_000, credits: 5_000, role: 'player' },
  { username: 'moderador', email: 'mod@dev.streampolis', coins: 0, credits: 0, role: 'moderator' },
];

async function seedUser(user: DevUser, passwordHash: string): Promise<string> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role, age_verified)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (username_lower) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [user.email, user.username, passwordHash, user.role],
    );
    const id = rows[0].id;

    await client.query('INSERT INTO profiles (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [
      id,
      user.username[0].toUpperCase() + user.username.slice(1),
    ]);
    await client.query('INSERT INTO player_stats (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [id]);
    await client.query(
      'INSERT INTO avatars (user_id, config) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
      [id, JSON.stringify(DEFAULT_AVATAR_DTO)],
    );

    // Saldo de desenvolvimento entra direto na carteira, sem passar pelo ledger:
    // é dinheiro que nunca existiu, e uma linha de ledger fingindo compra
    // poluiria a auditoria da economia (§65).
    await client.query(
      `INSERT INTO wallets (user_id, coins_balance, credits_balance) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET coins_balance = GREATEST(wallets.coins_balance, EXCLUDED.coins_balance),
             credits_balance = GREATEST(wallets.credits_balance, EXCLUDED.credits_balance)`,
      [id, user.coins, user.credits],
    );

    // Itens grátis do catálogo, para o criador de avatar ter o que mostrar.
    await client.query(
      `INSERT INTO inventory (user_id, item_id)
       SELECT $1, id FROM items WHERE active AND credits_price = 0
       ON CONFLICT (user_id, item_id) DO NOTHING`,
      [id],
    );

    await client.query(
      `INSERT INTO properties (owner_id, property_type, layout_id)
       SELECT $1, 'apartment', 'studio_01'
        WHERE NOT EXISTS (SELECT 1 FROM properties WHERE owner_id = $1)`,
      [id],
    );

    return id;
  });
}

export async function seed(log: (msg: string) => void = console.log): Promise<void> {
  if (config.isProd) {
    throw new Error('seed de desenvolvimento não roda em produção');
  }
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  for (const user of DEV_USERS) {
    const id = await seedUser(user, passwordHash);
    log(`  ${user.username.padEnd(10)} ${id}`);
  }
  log(`\nSenha de todas as contas: ${DEV_PASSWORD}`);
  log('Token de sessão: POST /auth/dev-login {"username":"ana"}');
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('[seed] falhou:', err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
