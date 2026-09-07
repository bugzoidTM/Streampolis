import { pool } from '../db/pool.ts';
import { grantCredits } from '../economy/EconomyService.ts';
import { EconomyError } from '../economy/errors.ts';

/**
 * Missões (PRD §24).
 *
 * "Missões ajudam novos jogadores a entender o jogo", com recompensa em
 * Credits, XP e cosméticos iniciais. Os oito exemplos do PRD estão aqui quase
 * literalmente — e a observação que decidiu o desenho é que **todos eles já
 * acontecem**: o avatar já é gravado, a praça já publica presença, o follow já
 * tem tabela, o PK já vira linha. Não faltava saber se a pessoa fez; faltava
 * perguntar, e ter algo do outro lado.
 *
 * ## Progresso é consulta, não contador
 *
 * Não existe tabela de progresso. Cada missão é um SELECT sobre os fatos que o
 * sistema já registra, e é isso que impede a segunda verdade clássica: a pessoa
 * fez a live, o contador não subiu, e o suporte não tem como responder. O que
 * se guarda é só o que não dá para deduzir — se a recompensa já foi paga.
 *
 * ## A recompensa é pedida, não empurrada
 *
 * O jogo poderia creditar sozinho no instante em que a missão fecha. Resgatar é
 * melhor por dois motivos: o dinheiro aparece quando a pessoa está OLHANDO (é o
 * momento em que a recompensa ensina o que ela acabou de fazer), e um crédito
 * que ninguém pediu, no meio de uma live, é ruído.
 *
 * ## Cosméticos ficam para depois, e de propósito
 *
 * O §24 fala em "cosméticos iniciais" como recompensa. Toda peça grátis do
 * catálogo já entra no guarda-roupa no cadastro (ver `registerAccount`), então
 * dar de novo o que a pessoa já tem seria uma recompensa vazia. O dia em que
 * existir uma peça exclusiva de missão, ela entra aqui como um terceiro campo.
 */

export interface MissionDef {
  id: string;
  title: string;
  hint: string;
  credits: number;
  xp: number;
  /** SQL que devolve 1 linha quando a missão está cumprida. `$1` é o usuário. */
  done: string;
}

/**
 * A ordem é a do roteiro do PRD, que é também a ordem em que as coisas ficam
 * mais difíceis: vestir o avatar é o primeiro clique; abrir a própria live e
 * entrar num PK são o fim da primeira sessão bem-sucedida.
 *
 * Os valores sobem junto, e são pequenos de propósito: missão é empurrão para
 * conhecer o jogo, não fonte de renda. O sofá mais barato da loja custa mais do
 * que a volta inteira paga.
 */
export const MISSIONS: readonly MissionDef[] = [
  {
    id: 'avatar', title: 'Complete seu avatar', hint: 'Escolha um visual na tela de look.',
    credits: 50, xp: 10,
    done: `SELECT 1 FROM onboarding_steps WHERE user_id = $1 AND step = 'create_avatar'`,
  },
  {
    id: 'plaza', title: 'Visite a praça', hint: 'A Praça Central é onde a cidade se encontra.',
    credits: 50, xp: 10,
    done: `SELECT 1 FROM onboarding_steps WHERE user_id = $1 AND step = 'enter_plaza'`,
  },
  {
    id: 'follow', title: 'Siga um streamer', hint: 'Abra um perfil e toque em Seguir.',
    credits: 60, xp: 15,
    done: 'SELECT 1 FROM follows WHERE follower_id = $1 LIMIT 1',
  },
  {
    id: 'watch_live', title: 'Assista a uma live', hint: 'Escolha alguém no feed de lives.',
    credits: 60, xp: 15,
    done: `SELECT 1 FROM onboarding_steps WHERE user_id = $1 AND step = 'watch_live'`,
  },
  {
    id: 'friend', title: 'Conheça outro jogador', hint: 'Mande um convite de amizade e seja aceito.',
    credits: 80, xp: 20,
    done: `SELECT 1 FROM friendships
            WHERE status = 'accepted' AND (user_a = $1 OR user_b = $1) LIMIT 1`,
  },
  {
    id: 'apartment', title: 'Visite um apartamento', hint: 'A porta de um amigo, ou a sua.',
    credits: 60, xp: 15,
    done: `SELECT 1 FROM onboarding_steps WHERE user_id = $1 AND step = 'visit_apartment'`,
  },
  {
    id: 'decorate', title: 'Personalize seu apartamento', hint: 'Coloque ao menos um móvel na sua casa.',
    credits: 80, xp: 20,
    done: `SELECT 1 FROM property_items pi
             JOIN properties p ON p.id = pi.property_id
            WHERE p.owner_id = $1 LIMIT 1`,
  },
  {
    id: 'go_live', title: 'Faça sua primeira live', hint: 'Toque em Go Live e transmita.',
    credits: 120, xp: 40,
    done: `SELECT 1 FROM onboarding_steps WHERE user_id = $1 AND step = 'open_live'`,
  },
  {
    id: 'pk', title: 'Participe de um PK', hint: 'Convide alguém ao palco e comece uma batalha.',
    credits: 150, xp: 50,
    done: 'SELECT 1 FROM pk_matches WHERE host_a = $1 OR host_b = $1 LIMIT 1',
  },
] as const;

const BY_ID = new Map(MISSIONS.map((m) => [m.id, m]));

export interface MissionView {
  id: string;
  title: string;
  hint: string;
  credits: number;
  xp: number;
  done: boolean;
  claimed: boolean;
  claimedAt: string | null;
}

export interface MissionsView {
  missions: MissionView[];
  /** Quantas estão cumpridas e ainda não resgatadas — o número do badge. */
  claimable: number;
  completed: number;
  total: number;
}

/**
 * Uma consulta só para as nove missões.
 *
 * Nove SELECTs em sequência seriam nove idas ao banco a cada vez que a tela
 * abre. Um `UNION ALL` de EXISTS resolve tudo numa viagem — e continua sendo
 * derivado dos fatos, sem tabela de progresso.
 */
export async function listMissions(userId: string): Promise<MissionsView> {
  const partes = MISSIONS.map((m, i) => `SELECT '${m.id}' AS id, EXISTS (${m.done}) AS done`
    + (i === 0 ? '' : ''));
  const feitas = await pool.query<{ id: string; done: boolean }>(partes.join(' UNION ALL '), [userId]);
  const estado = new Map(feitas.rows.map((r) => [r.id, r.done]));

  const resgates = await pool.query<{ mission_id: string; claimed_at: Date }>(
    'SELECT mission_id, claimed_at FROM mission_claims WHERE user_id = $1', [userId],
  );
  const resgatadas = new Map(resgates.rows.map((r) => [r.mission_id, r.claimed_at]));

  const missions = MISSIONS.map((m) => ({
    id: m.id,
    title: m.title,
    hint: m.hint,
    credits: m.credits,
    xp: m.xp,
    done: estado.get(m.id) ?? false,
    claimed: resgatadas.has(m.id),
    claimedAt: resgatadas.get(m.id)?.toISOString() ?? null,
  }));

  return {
    missions,
    claimable: missions.filter((m) => m.done && !m.claimed).length,
    completed: missions.filter((m) => m.done).length,
    total: missions.length,
  };
}

export interface ClaimResult {
  missionId: string;
  credits: number;
  xp: number;
  balances: { coins: number; credits: number };
  /** Já tinha sido resgatada; nada foi pago de novo. */
  replayed: boolean;
}

/**
 * Resgatar.
 *
 * Três recusas, nesta ordem: missão que não existe, missão não cumprida, e
 * missão já resgatada. A terceira é a que precisa ser à prova de corrida — dois
 * cliques rápidos no mesmo botão são o caso comum, não o exótico —, e quem
 * garante isso é a chave primária de `mission_claims` mais a chave de
 * idempotência do ledger. Duas travas para o mesmo dinheiro, de propósito.
 */
export async function claimMission(userId: string, missionId: string): Promise<ClaimResult> {
  const missao = BY_ID.get(missionId);
  if (!missao) throw new EconomyError('ITEM_UNKNOWN', 'Missão desconhecida.', 404);

  const feita = await pool.query(`SELECT EXISTS (${missao.done}) AS done`, [userId]);
  if (!feita.rows[0].done) {
    throw new EconomyError('ITEM_NOT_OWNED', 'Esta missão ainda não foi cumprida.', 409);
  }

  const marca = await pool.query(
    `INSERT INTO mission_claims (user_id, mission_id, credits, xp)
     VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, mission_id) DO NOTHING
     RETURNING mission_id`,
    [userId, missao.id, missao.credits, missao.xp],
  );
  const jaResgatada = marca.rowCount === 0;

  const saldo = await grantCredits({
    userId,
    amount: missao.credits,
    referenceType: 'mission',
    referenceId: missao.id,
    idempotencyKey: `mission_${missao.id}_${userId}`,
  });

  if (!jaResgatada) {
    await pool.query(
      'UPDATE mission_claims SET tx_id = $3 WHERE user_id = $1 AND mission_id = $2',
      [userId, missao.id, saldo.transaction.id],
    );
    // XP fica em `player_stats`, que é onde o resto da progressão mora. Fora da
    // transação do ledger de propósito: XP não é dinheiro, e um XP perdido numa
    // falha rara é melhor do que um crédito preso numa transação maior.
    await pool.query(
      'UPDATE player_stats SET xp = xp + $2, updated_at = now() WHERE user_id = $1',
      [userId, missao.xp],
    );
  }

  return {
    missionId: missao.id,
    credits: missao.credits,
    xp: missao.xp,
    balances: saldo.balances,
    replayed: jaResgatada || saldo.replayed,
  };
}
