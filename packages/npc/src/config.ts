/**
 * Tudo que o worker do personagem lê do ambiente, num lugar só.
 *
 * Postura igual à da API e do game server: em produção nada tem default
 * silencioso — segredo vazio derruba o processo no boot em vez de deixar o
 * personagem entrar na praça sem cabeça.
 */

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

export const config = {
  /** Qual personagem este processo é. Um processo = um personagem. */
  npcSlug: env('NPC_SLUG', 'nilo'),

  apiBaseUrl: env('API_BASE_URL', 'http://127.0.0.1:8787'),
  apiServiceToken: env('API_SERVICE_TOKEN', 'dev-only-service-token'),

  /** Onde o matchmaking atende. Em produção, o gateway interno do swarm. */
  gameServerUrl: env('GAME_SERVER_URL', 'ws://127.0.0.1:2567'),
  /**
   * No modo distribuído a reserva de assento volta com o endereço PÚBLICO da
   * sala (`streampolis.nutef.com/ws/1`). De dentro da rede o caminho curto é
   * o gateway, que já sabe que `/1/` é o sp-game e `/2/` o sp-game-2 — então
   * o prefixo público é trocado pelo host interno antes de conectar. Vazio =
   * sem troca (desenvolvimento, um processo só).
   */
  gamePublicPrefix: env('GAME_PUBLIC_PREFIX', ''),
  gameInternalHost: env('GAME_INTERNAL_HOST', ''),

  databaseUrl: env('DATABASE_URL', 'postgres://streampolis:streampolis_dev_pw@127.0.0.1:55432/streampolis'),
  dbSchema: env('DB_SCHEMA', 'streampolis'),

  /**
   * Dois níveis de modelo, e a divisão é por CUSTO: a conversa é frequente e
   * pode ser boa o bastante; diário, persona e auditoria são raros e precisam
   * ser bons. Os dois são fachadas OpenAI (`/v1/chat/completions`).
   */
  llm: {
    chat: {
      url: env('LLM_CHAT_URL', 'http://qwenproxy:3000/v1/chat/completions'),
      key: env('LLM_CHAT_KEY', ''),
      model: env('LLM_CHAT_MODEL', 'qwen3-vl-plus-no-thinking'),
      timeoutMs: num('LLM_CHAT_TIMEOUT_MS', 90_000),
    },
    deep: {
      url: env('LLM_DEEP_URL', 'http://chatgptproxy:3000/v1/chat/completions'),
      key: env('LLM_DEEP_KEY', ''),
      model: env('LLM_DEEP_MODEL', 'gpt-5'),
      timeoutMs: num('LLM_DEEP_TIMEOUT_MS', 240_000),
    },
    /**
     * Teto de chamadas por dia, contando as duas camadas. Não é dinheiro — os
     * proxies são de graça — mas é o que impede um flood de chat de virar um
     * flood no proxy que a Radar e o Dramaturgo também usam.
     */
    dailyBudget: num('NPC_DAILY_CALL_BUDGET', 600),
  },

  healthPort: num('NPC_HEALTH_PORT', 8791),

  /** Quantas trocas de conversa (ou horas) entre uma reflexão e a próxima. */
  reflectEveryExchanges: num('NPC_REFLECT_EXCHANGES', 12),
  reflectEveryHours: num('NPC_REFLECT_HOURS', 6),
} as const;

export function assertProductionConfig(): void {
  if (!isProduction()) return;
  const missing: string[] = [];
  if (config.apiServiceToken === 'dev-only-service-token') missing.push('API_SERVICE_TOKEN');
  if (!config.llm.chat.key) missing.push('LLM_CHAT_KEY');
  if (!config.llm.deep.key) missing.push('LLM_DEEP_KEY');
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
  if (missing.length) throw new Error(`Em produção estas variáveis são obrigatórias: ${missing.join(', ')}`);
}
