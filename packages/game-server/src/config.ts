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

  cityCapacity: num('CITY_CAPACITY', 36),
  apartmentCapacity: num('APARTMENT_CAPACITY', 12),
  liveCapacity: num('LIVE_CAPACITY', 100),

  env: str('NODE_ENV', 'development'),
};

export function isProduction(): boolean {
  return config.env === 'production';
}
