/** Process configuration. Everything overridable by environment (SPECs §53). */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export const config = {
  port: num('GAME_SERVER_PORT', 2567),
  host: str('GAME_SERVER_HOST', '0.0.0.0'),
  redisUrl: str('REDIS_URL', ''),
  publicAddress: str('GAME_SERVER_PUBLIC_ADDRESS', ''),
  distributed: str('GAME_SERVER_DISTRIBUTED', '') === '1',

  /**
   * Shared secret for the short-lived WebSocket token (SPECs §36). The API
   * mints it; the game server only verifies. There is no fallback value on
   * purpose in production — see requireAuthSecret().
   */
  authSecret: str('AUTH_JWT_SECRET', ''),
  /** Dev escape hatch: accept unsigned identities. Never enable in production. */
  authDevBypass: str('AUTH_DEV_BYPASS', '') === '1',
  /** Clock skew tolerated when checking exp/nbf, in seconds. */
  authLeewaySec: num('AUTH_LEEWAY_SEC', 30),
  /**
   * Who is allowed to have minted the token. Checking the issuer is what stops
   * a token signed with the same secret for a DIFFERENT purpose (a webhook, a
   * partner integration, an internal tool) from being accepted as a session.
   */
  authIssuer: str('AUTH_JWT_ISSUER', 'streampolis-api'),

  /** Base URL of packages/api. Empty = use the in-memory economy stub. */
  apiBaseUrl: str('API_BASE_URL', ''),
  apiServiceToken: str('API_SERVICE_TOKEN', ''),

  /**
   * Identidade deste PROCESSO no diretório de presença. Fixa por deploy quando
   * declarada; sorteada quando não — duas réplicas com o mesmo id sobrescrevem
   * a fatia uma da outra e metade dos jogadores some do mapa.
   */
  serverId: str('GAME_SERVER_ID', `gs_${Math.random().toString(36).slice(2, 10)}`),
  /** Janela de coalescência do retrato de presença (§17). */
  presenceFlushMs: num('PRESENCE_FLUSH_MS', 150),
  /** Batimento do retrato. Tem de ser bem menor que o TTL do lado da API. */
  presenceHeartbeatMs: num('PRESENCE_HEARTBEAT_MS', 15_000),

  cityCapacity: num('CITY_CAPACITY', 36),
  cityAoiRadius: num('CITY_AOI_RADIUS', 24),
  cityAoiLeaveRadius: num('CITY_AOI_LEAVE_RADIUS', 28),
  apartmentCapacity: num('APARTMENT_CAPACITY', 12),
  liveCapacity: num('LIVE_CAPACITY', 100),

  env: str('NODE_ENV', 'development'),
};

export function isProduction(): boolean {
  return config.env === 'production';
}
