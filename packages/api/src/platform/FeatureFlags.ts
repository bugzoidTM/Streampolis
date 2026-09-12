import { pool } from '../db/pool.ts';

/**
 * Feature flags (SPECs §64).
 *
 * A tabela `feature_flags` existe desde a migration 0004 e as seis chaves que o
 * §64 pede foram semeadas na 0005. **Ninguém nunca as leu.** Eram seis linhas
 * de banco que davam a impressão de existir um controle que não existia — e
 * essa é a pior forma de uma flag: a que alguém desliga numa emergência
 * achando que fez efeito.
 *
 * ## O que uma flag serve para fazer aqui
 *
 * Desligar um pedaço do jogo sem deploy, quando algo dá errado com dinheiro no
 * meio. É a diferença entre "reverter a stack e torcer" e "desligar o PK por
 * vinte minutos enquanto se investiga".
 *
 * ## Cache curto, e o motivo do número
 *
 * 15 segundos. Elas são lidas em rotas quentes (o checkout, o convite de
 * agência), e ir ao banco em toda leitura seria pagar caro por um valor que
 * quase nunca muda. Por outro lado, uma flag de emergência que leva minutos
 * para pegar não serve para emergência — 15 s é o meio-termo entre as duas
 * frases. Mudar pelo painel limpa o cache na hora, então o operador vê o efeito
 * imediatamente no processo que ele mexeu.
 */

export interface FlagRow {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: string | null;
  /**
   * Alguma parte do código realmente CONSULTA esta flag?
   *
   * Existe porque metade das chaves do §64 aponta para coisas que ainda não
   * foram construídas (voz, creator program). Uma flag que não é lida por
   * ninguém precisa dizer isso no painel — senão ela é um botão que promete um
   * efeito que não acontece.
   */
  effective: boolean;
}

/** As flags que o código de fato consulta hoje. O resto é declaração. */
export const FLAGS_EM_USO: ReadonlySet<string> = new Set([
  'real_payments',
  'agencies_enabled',
  'pk_enabled',
  'events_enabled',
  // Lida pelo worker do personagem (packages/npc), direto do banco.
  'npc_enabled',
]);

const CACHE_MS = 15_000;
let cache: { at: number; valores: Map<string, boolean> } | null = null;

async function carregar(): Promise<Map<string, boolean>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.valores;
  const { rows } = await pool.query<{ key: string; enabled: boolean }>(
    'SELECT key, enabled FROM feature_flags',
  );
  const valores = new Map(rows.map((r) => [r.key, r.enabled]));
  cache = { at: Date.now(), valores };
  return valores;
}

export function invalidateFlagCache(): void {
  cache = null;
}

/**
 * A flag está ligada?
 *
 * `fallback` é o valor quando a chave não existe no banco **ou quando o banco
 * não responde**: uma flag que falha fechada derrubaria o jogo inteiro numa
 * instabilidade de leitura, e uma que falha aberta ligaria o que estava
 * desligado. Por isso quem chama declara o lado seguro do SEU caso — o checkout
 * passa `false`, as agências passam `true`.
 */
export async function isEnabled(key: string, fallback: boolean): Promise<boolean> {
  try {
    const valores = await carregar();
    return valores.get(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function listFlags(): Promise<FlagRow[]> {
  const { rows } = await pool.query(
    'SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key',
  );
  return rows.map((r) => ({
    key: r.key,
    enabled: r.enabled,
    description: r.description,
    updatedAt: r.updated_at ? r.updated_at.toISOString() : null,
    effective: FLAGS_EM_USO.has(r.key),
  }));
}

export async function setFlag(key: string, enabled: boolean, actorId: string): Promise<FlagRow | null> {
  const { rows } = await pool.query(
    `UPDATE feature_flags SET enabled = $2, updated_by = $3, updated_at = now()
      WHERE key = $1
      RETURNING key, enabled, description, updated_at`,
    [key, enabled, actorId],
  );
  if (!rows[0]) return null;
  // Quem mudou vê o efeito agora, não daqui a 15 s.
  invalidateFlagCache();
  return {
    key: rows[0].key,
    enabled: rows[0].enabled,
    description: rows[0].description,
    updatedAt: rows[0].updated_at ? rows[0].updated_at.toISOString() : null,
    effective: FLAGS_EM_USO.has(rows[0].key),
  };
}

/** Snapshot para quem não fala com o banco — o game server (§64 + §54). */
export async function flagsSnapshot(): Promise<Record<string, boolean>> {
  const valores = await carregar();
  return Object.fromEntries(valores);
}
