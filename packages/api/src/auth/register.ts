import bcrypt from 'bcryptjs';
import { withTransaction, isUniqueViolation } from '../db/tx.ts';
import { DEFAULT_AVATAR_DTO } from './identity.ts';

/**
 * Cadastro (SPECs §36, §51 `/auth/*`).
 *
 * Até aqui a única porta do jogo era `dev-login`: escolher um personagem de
 * fixture, sem senha, numa API que só oferece isso fora de produção. Era
 * deliberado enquanto não havia conta de verdade — e é exatamente o que impede
 * o jogo de valer dinheiro (ver `deploy/README.md`).
 *
 * Esta função cria a conta e nada mais: quem emite a sessão é
 * `issueSessionTokens`, o MESMO caminho do login. Duas formas de nascer uma
 * sessão seriam duas formas de errar o refresh, e a rotação de família (§36) é
 * a parte que não pode ter uma segunda implementação.
 *
 * OAuth não entra aqui. A coluna `auth_provider` existe desde 0001 justamente
 * para o dia em que entrar, e o CHECK do schema já garante que só conta
 * `'password'` é obrigada a ter hash.
 */

/**
 * Custo do bcrypt.
 *
 * 10, e não mais, por dois motivos que se somam: `bcryptjs` é JavaScript puro
 * (bem mais lento que o nativo, então cada incremento pesa em dobro numa rota
 * que roda no caminho crítico do login), e é o custo do hash inválido que o
 * login compara quando o usuário não existe — a defesa contra enumerar contas
 * por tempo de resposta só funciona se os dois lados custarem o mesmo.
 */
export const PASSWORD_COST = 10;

export type RegisterErrorCode = 'USERNAME_TAKEN' | 'EMAIL_TAKEN' | 'WEAK_PASSWORD';

export class RegisterError extends Error {
  readonly code: RegisterErrorCode;
  readonly httpStatus: number;

  constructor(code: RegisterErrorCode, message: string, httpStatus = 409) {
    super(message);
    this.name = 'RegisterError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
}

/**
 * Recusas que nenhum medidor de força pega e que são as três senhas que as
 * pessoas realmente escolhem numa tela de cadastro de jogo. O comprimento
 * mínimo é do schema da rota; isto é o que sobra depois dele.
 */
function assertUsablePassword(input: RegisterInput): void {
  const password = input.password;
  const lower = password.toLowerCase();
  if (lower === input.username.toLowerCase() || lower === input.email.toLowerCase()) {
    throw new RegisterError('WEAK_PASSWORD', 'A senha não pode ser o seu nome nem o seu e-mail.', 400);
  }
  if (new Set(password).size < 4) {
    throw new RegisterError('WEAK_PASSWORD', 'Escolha uma senha com mais variedade de caracteres.', 400);
  }
}

/**
 * Cria a conta e tudo que uma conta precisa ter para o jogo não quebrar no
 * primeiro clique.
 *
 * A lista sai do `seed`, que é o único lugar que já sabia montar um jogador
 * inteiro: perfil, progressão, carteira, aparência e o guarda-roupa de estreia.
 * Sem os itens grátis, o criador de avatar abre vazio; sem a carteira, o extrato
 * responde erro em vez de zero.
 *
 * Tudo numa transação: meia conta criada — usuário sem carteira, por exemplo —
 * seria um jogador impossível de consertar sem SQL à mão.
 *
 * O apartamento NÃO nasce aqui: `getOrCreateHomeOf` já o cria na primeira
 * visita, e duas origens para a mesma casa é como se acaba com dois
 * apartamentos para a mesma pessoa.
 */
export async function registerAccount(input: RegisterInput): Promise<string> {
  assertUsablePassword(input);
  const passwordHash = await bcrypt.hash(input.password, PASSWORD_COST);

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, username, password_hash, auth_provider, role)
         VALUES ($1, $2, $3, 'password', 'player')
         RETURNING id`,
        [input.email, input.username, passwordHash],
      );
      const id = rows[0].id;

      await client.query(
        'INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)',
        [id, input.username],
      );
      await client.query('INSERT INTO player_stats (user_id) VALUES ($1)', [id]);
      await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [id]);
      await client.query(
        'INSERT INTO avatars (user_id, config) VALUES ($1, $2)',
        [id, JSON.stringify(DEFAULT_AVATAR_DTO)],
      );
      // Guarda-roupa de estreia: o que é grátis no catálogo. `validateAvatar`
      // deixa vestir item grátis mesmo sem posse, então isto não muda o que a
      // pessoa PODE usar — muda o que ela VÊ como seu na tela de look.
      await client.query(
        `INSERT INTO inventory (user_id, item_id)
         SELECT $1, id FROM items WHERE active AND credits_price = 0
         ON CONFLICT (user_id, item_id) DO NOTHING`,
        [id],
      );

      return id;
    });
  } catch (err) {
    // Os índices são sobre as colunas GERADAS em minúsculas: "Ana" e "ana" são
    // o mesmo nome, e é o banco que decide isso, não uma checagem prévia que
    // duas requisições simultâneas passariam juntas.
    if (isUniqueViolation(err, 'users_username_lower_key')) {
      throw new RegisterError('USERNAME_TAKEN', 'Este nome de usuário já está em uso.');
    }
    if (isUniqueViolation(err, 'users_email_lower_key')) {
      throw new RegisterError('EMAIL_TAKEN', 'Já existe uma conta com este e-mail.');
    }
    throw err;
  }
}
