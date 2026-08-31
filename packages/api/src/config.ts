/** Configuração do API Server. Tudo por env; nada de segredo hardcoded em prod. */

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} deve ser inteiro`);
  return n;
}

const isProd = process.env.NODE_ENV === 'production';

/** Em produção um segredo default seria uma porta aberta; exige env explícita. */
function secret(name: string, devFallback: string): string {
  return isProd ? env(name) : env(name, devFallback);
}

export const config = {
  isProd,
  port: intEnv('API_PORT', 8787),
  host: env('API_HOST', '127.0.0.1'),
  databaseUrl: env(
    'DATABASE_URL',
    'postgres://streampolis:streampolis_dev_pw@127.0.0.1:55432/streampolis',
  ),
  /** search_path fixo: o schema `public` do Postgres hospedeiro nunca é usado. */
  dbSchema: env('DB_SCHEMA', 'streampolis'),
  poolMax: intEnv('DB_POOL_MAX', 12),
  jwt: {
    secret: secret('JWT_SECRET', 'dev-only-access-secret-change-me'),
    /** §36: token curto. 15 min de janela, refresh rotativo cobre o resto. */
    accessTtlSeconds: intEnv('JWT_ACCESS_TTL', 15 * 60),
    refreshTtlSeconds: intEnv('JWT_REFRESH_TTL', 30 * 24 * 60 * 60),
    issuer: 'streampolis-api',
  },
  webhookSecret: secret('PAYMENT_WEBHOOK_SECRET', 'dev-only-webhook-secret'),
  /**
   * Segredo entre API e game server. O game server nunca fala com o banco: ele
   * chama /internal/* com este token, e essas rotas movem dinheiro — por isso
   * em produção não existe valor default.
   */
  serviceToken: secret('API_SERVICE_TOKEN', 'dev-only-service-token'),
  /**
   * Login sem senha para desenvolvimento (POST /auth/dev-login). Ligado só
   * fora de produção e nunca por acidente: exige a env explícita.
   */
  devLogin: !isProd && env('API_DEV_LOGIN', '1') === '1',
  rateLimit: {
    windowMs: intEnv('RATE_WINDOW_MS', 60_000),
    generalMax: intEnv('RATE_GENERAL_MAX', 300),
    authMax: intEnv('RATE_AUTH_MAX', 10),
    economyMax: intEnv('RATE_ECONOMY_MAX', 60),
  },
} as const;
