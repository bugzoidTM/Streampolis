/**
 * Seed de desenvolvimento.
 *
 * Gifts, pacotes e flags vêm da migration 0005 — quem cobra é o banco, e o
 * preço não pode depender de um script ter rodado.
 *
 * O CATÁLOGO DE ITENS é a exceção, e por um motivo aprendido na marra: ele
 * estava escrito duas vezes, em `shared/items.ts` e em SQL, e as duas listas
 * saíram do lugar. O sintoma foi comprar um móvel novo e a API responder
 * "item inexistente" — a loja mostrava o que a economia não conhecia. Aqui ele
 * é ESPELHADO a partir de `shared`, que é a fonte única.
 *
 * Este arquivo também cria as CONTAS de desenvolvimento que o game server e o
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
import { ITEM_CATALOG } from '../shared.ts';

interface DevUser {
  username: string;
  email: string;
  coins: number;
  credits: number;
  role: 'player' | 'moderator' | 'admin';
  /**
   * Aparência de estreia. Existe por um motivo de produto: a tela de entrada
   * mostra os personagens, e três avatares idênticos começam a demonstração
   * dizendo que dá no mesmo quem você escolhe.
   */
  look?: Partial<typeof DEFAULT_AVATAR_DTO>;
}

/**
 * Espelha `ITEM_CATALOG` na tabela `items`. Idempotente: roda a cada seed e
 * atualiza nome, preço e disponibilidade de quem já existe.
 */
export async function mirrorCatalog(): Promise<number> {
  await withTransaction(async (client) => {
    for (const item of ITEM_CATALOG) {
      await client.query(
        `INSERT INTO streampolis.items
           (id, type, name, rarity, credits_price, coins_price, asset_id, footprint_x, footprint_y, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           type = EXCLUDED.type, name = EXCLUDED.name, rarity = EXCLUDED.rarity,
           credits_price = EXCLUDED.credits_price, coins_price = EXCLUDED.coins_price,
           asset_id = EXCLUDED.asset_id,
           footprint_x = EXCLUDED.footprint_x, footprint_y = EXCLUDED.footprint_y,
           active = EXCLUDED.active`,
        [
          item.id, item.type, item.name, item.rarity,
          item.creditsPrice, item.coinsPrice, item.assetId,
          item.footprint?.[0] ?? null, item.footprint?.[1] ?? null,
          item.active,
        ],
      );
    }

    // O que SAIU do catálogo é desativado, não apagado.
    //
    // Espelhar só o que existe deixava para trás os itens retirados, ainda
    // ativos e ainda vestíveis: quando o guarda-roupa procedural saiu de cena,
    // as 45 peças velhas continuaram no banco e um avatar antigo seguiu
    // apontando para elas. Apagar quebraria inventário e extrato — a compra
    // aconteceu, e um extrato com item inexistente é pior do que um item que
    // não se vende mais.
    await client.query(
      `UPDATE streampolis.items SET active = false
        WHERE active AND id <> ALL($1::text[])`,
      [ITEM_CATALOG.map((i) => i.id)],
    );
  });
  return ITEM_CATALOG.length;
}

const DEV_PASSWORD = 'streampolis-dev';

const DEV_USERS: DevUser[] = [
  {
    username: 'ana', email: 'ana@dev.streampolis', coins: 50_000, credits: 20_000, role: 'player',
    look: {
      // Peças do guarda-roupa v2 (ver `shared/items.ts`): `hair` é a CABEÇA.
      bodyPreset: 2, skinTone: 3, facePreset: 1, hair: 'f_suit_head', hairColor: 4,
      top: 'f_suit_top', bottom: 'f_suit_bottom', shoes: 'f_suit_shoes', height: 1.0,
    },
  },
  {
    username: 'beto', email: 'beto@dev.streampolis', coins: 50_000, credits: 20_000, role: 'player',
    look: {
      bodyPreset: 1, skinTone: 6, facePreset: 2, hair: 'm_hoodie_character_head', hairColor: 0,
      top: 'm_hoodie_character_top', bottom: 'm_worker_bottom', shoes: 'm_casual_character_shoes', height: 1.05,
    },
  },
  {
    username: 'caio', email: 'caio@dev.streampolis', coins: 5_000, credits: 5_000, role: 'player',
    look: {
      bodyPreset: 3, skinTone: 1, facePreset: 3, hair: 'm_business_man_head', hairColor: 2,
      top: 'm_business_man_top', bottom: 'm_business_man_bottom', shoes: 'm_business_man_shoes', height: 0.96,
    },
  },
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
    const look = { ...DEFAULT_AVATAR_DTO, ...(user.look ?? {}) };
    // Atualiza o visual só se ele ainda for o padrão: quem já se vestiu no jogo
    // não perde o próprio look porque alguém rodou o seed de novo.
    await client.query(
      `INSERT INTO avatars (user_id, config) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
        WHERE avatars.config = $3::jsonb`,
      [id, JSON.stringify(look), JSON.stringify(DEFAULT_AVATAR_DTO)],
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

    // Vestir exige possuir (AvatarService): o guarda-roupa de estreia entrega o
    // que o look usa, senão a API recusa a própria aparência que o seed criou.
    const wearing = [look.hair, look.top, look.bottom, look.shoes, look.accessory]
      .filter((itemId): itemId is string => Boolean(itemId));
    if (wearing.length > 0) {
      await client.query(
        `INSERT INTO inventory (user_id, item_id)
         SELECT $1, id FROM items WHERE active AND id = ANY($2::text[])
         ON CONFLICT (user_id, item_id) DO NOTHING`,
        [id, wearing],
      );
    }

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
  log(`  catálogo: ${await mirrorCatalog()} itens espelhados de shared/items.ts`);

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
