#!/usr/bin/env node
/**
 * As contas do teste de carga. Roda DENTRO do container da API — é lá que o
 * Postgres da stack é alcançável — e é o único pedaço do teste que toca o banco.
 *
 *   node tools/load-users.mjs create --stamp=abc --n=173
 *   node tools/load-users.mjs drop   --stamp=abc
 *
 * Imprime JSON em stdout (o driver no host lê daqui), e nada mais: qualquer
 * outra saída vira ruído no parse.
 *
 * ## Por que contas de VERDADE, e não ids inventados
 *
 * O game server não consulta o banco para autenticar — ele só confere a
 * assinatura do JWT —, então ids inventados entrariam no mundo sem problema. O
 * que quebraria é o que vem DEPOIS: o retrato de presença que cada worker
 * publica na API vira escrita de onboarding, e onboarding tem chave estrangeira
 * para `users`. Com id fantasma, cada batimento viraria uma violação de FK: o
 * teste mediria o Postgres reclamando em vez do jogo funcionando.
 *
 * ## Estas contas SOMEM no fim
 *
 * Diferente das do `release-check`, elas não presenteiam nem lutam PK, então
 * não deixam extrato nem histórico — nada com ON DELETE RESTRICT apontando para
 * elas. Por isso podem (e devem) ser apagadas ao fim da rodada: 173 contas por
 * execução acumulariam depressa no banco de produção.
 */
import { pool, closePool } from '../packages/api/src/db/pool.ts';
import { DEFAULT_AVATAR_DTO } from '../packages/api/src/auth/identity.ts';

const [, , comando, ...resto] = process.argv;
const args = Object.fromEntries(resto.map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const STAMP = args.stamp;
if (!STAMP || !/^[a-z0-9]{1,12}$/.test(STAMP)) {
  console.error('--stamp=<a-z0-9, até 12> é obrigatório');
  process.exit(2);
}
const PREFIXO = `lt_${STAMP}_`;

/**
 * Hash de senha impossível de casar. As contas existem para o game server ver
 * um usuário de verdade do outro lado do JWT; nenhuma delas faz login, e uma
 * senha conhecida no banco de produção seria uma porta que ninguém pediu.
 */
const SENHA_INUTIL = '$2a$10$loadtestloadtestloadtestloadtestloadtestloadtestloadtestloa';

async function criar(n) {
  const criados = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < n; i++) {
      const username = `${PREFIXO}${String(i).padStart(3, '0')}`;
      const { rows } = await client.query(
        `INSERT INTO users (email, username, password_hash, role, status, age_verified)
         VALUES ($1, $2, $3, 'player', 'active', TRUE)
         ON CONFLICT (username_lower) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [`${username}@loadtest.streampolis`, username, SENHA_INUTIL],
      );
      const id = rows[0].id;
      // O mínimo para o jogador não quebrar no primeiro clique — a mesma lista
      // de `registerAccount`, menos o guarda-roupa (ninguém troca de roupa aqui).
      await client.query(
        'INSERT INTO profiles (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
        [id, username],
      );
      await client.query('INSERT INTO player_stats (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [id]);
      await client.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [id]);
      await client.query(
        'INSERT INTO avatars (user_id, config) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
        [id, JSON.stringify(DEFAULT_AVATAR_DTO)],
      );
      criados.push({ userId: id, username });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return criados;
}

async function apagar() {
  const { rowCount } = await pool.query(
    'DELETE FROM users WHERE username_lower LIKE $1',
    [`${PREFIXO.toLowerCase()}%`],
  );
  return rowCount;
}

try {
  if (comando === 'create') {
    const n = Number(args.n ?? 0);
    if (!Number.isInteger(n) || n < 1 || n > 1_000) throw new Error('--n entre 1 e 1000');
    console.log(JSON.stringify({ ok: true, users: await criar(n) }));
  } else if (comando === 'drop') {
    console.log(JSON.stringify({ ok: true, removidos: await apagar() }));
  } else {
    throw new Error('comando deve ser create ou drop');
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
  process.exitCode = 1;
} finally {
  await closePool();
}
