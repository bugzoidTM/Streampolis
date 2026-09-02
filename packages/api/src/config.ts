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
  /**
   * Quantos saltos de proxy confiar no X-Forwarded-For. 0 = nenhum (default
   * seguro para rodar exposto direto); 1 quando há um nginx/Cloudflare na
   * frente. Confiar sem proxy deixa qualquer um forjar o próprio IP e escapar
   * do limitador.
   */
  trustProxy: intEnv('API_TRUST_PROXY', 0),
  /**
   * Origens autorizadas a chamar a API do navegador, separadas por vírgula.
   * Vazio: em desenvolvimento libera quem chamar; em produção não libera
   * ninguém, e a lista passa a ser obrigatória.
   */
  corsOrigins: env('API_CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  /**
   * O fuso em que "hoje" acaba (PRD §23, filtro "Hoje").
   *
   * Em UTC o dia do ranking viraria às 21h de Brasília, no meio do horário de
   * maior audiência: o jogador veria o placar zerar enquanto ainda está
   * jogando. Quem manda no corte é o fuso do público, não o do servidor.
   */
  rankingsTimezone: env('RANKINGS_TIMEZONE', 'America/Sao_Paulo'),
  rateLimit: {
    windowMs: intEnv('RATE_WINDOW_MS', 60_000),
    generalMax: intEnv('RATE_GENERAL_MAX', 300),
    /**
     * Teto de /auth por minuto. Baixo em produção porque é ali que se testa
     * senha em massa; mais folgado em desenvolvimento porque um e2e que loga
     * três vezes, rodado quatro vezes seguidas, se trancaria para fora — e o
     * limitador existe para proteger a produção, não para atrapalhar o teste.
     */
    authMax: intEnv('RATE_AUTH_MAX', isProd ? 10 : 40),
    economyMax: intEnv('RATE_ECONOMY_MAX', 60),
    /** /internal/*: um chamador só (o game server), muitas chamadas legítimas. */
    serviceMax: intEnv('RATE_SERVICE_MAX', 3_000),
  },
} as const;
