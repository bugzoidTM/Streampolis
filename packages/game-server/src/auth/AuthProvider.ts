import { createHmac, timingSafeEqual } from 'node:crypto';
import { config, isProduction } from '../config.js';

/**
 * Identity the room trusts (SPECs §36). Produced ONLY by an AuthProvider —
 * never by anything the browser typed into join options.
 */
export interface AuthIdentity {
  userId: string;
  displayName: string;
  permissions: string[];
  /** Gifter tier, cosmetic-only here; the API owns the XP that produced it. */
  gifterLevel: number;
  agency: string;
  /** Opaque session id, useful to correlate with API audit logs. */
  sessionId: string;
}

export class AuthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Boundary with packages/api. The game server never reads the users table; it
 * verifies a short-lived token the API issued. Swap the implementation to talk
 * to the real API without touching a single Room.
 */
export interface AuthProvider {
  authenticate(token: string): Promise<AuthIdentity>;
}

interface JwtPayload {
  sub?: unknown;
  name?: unknown;
  perms?: unknown;
  gifterLevel?: unknown;
  agency?: unknown;
  sid?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

function b64urlToBuf(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * HS256 verifier written on node:crypto so the game server carries no JWT
 * dependency of its own. It validates signature, alg, exp and nbf — nothing
 * else, because everything else in the payload is the API's business.
 */
export class JwtAuthProvider implements AuthProvider {
  constructor(private readonly secret: string, private readonly leewaySec = config.authLeewaySec) {
    if (!secret) throw new Error('JwtAuthProvider requires a non-empty secret');
  }

  async authenticate(token: string): Promise<AuthIdentity> {
    if (typeof token !== 'string' || token.length === 0) {
      throw new AuthError('missing_token', 'Token ausente');
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthError('malformed_token', 'Token malformado');
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    let header: { alg?: unknown; typ?: unknown };
    let payload: JwtPayload;
    try {
      header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
      payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
    } catch {
      throw new AuthError('malformed_token', 'Token malformado');
    }

    // "alg": "none" and algorithm confusion are the two classic JWT holes.
    if (header.alg !== 'HS256') throw new AuthError('bad_alg', 'Algoritmo não suportado');

    const expected = createHmac('sha256', this.secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const got = b64urlToBuf(signatureB64);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      throw new AuthError('bad_signature', 'Assinatura inválida');
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now > payload.exp + this.leewaySec) {
      throw new AuthError('expired', 'Token expirado');
    }
    if (typeof payload.nbf === 'number' && now + this.leewaySec < payload.nbf) {
      throw new AuthError('not_yet_valid', 'Token ainda não válido');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AuthError('no_subject', 'Token sem sujeito');
    }

    return {
      userId: payload.sub,
      displayName: typeof payload.name === 'string' && payload.name ? payload.name : `Cidadão ${payload.sub.slice(0, 6)}`,
      permissions: Array.isArray(payload.perms) ? payload.perms.filter((p): p is string => typeof p === 'string') : [],
      gifterLevel: typeof payload.gifterLevel === 'number' ? payload.gifterLevel : 0,
      agency: typeof payload.agency === 'string' ? payload.agency : '',
      sessionId: typeof payload.sid === 'string' ? payload.sid : `${payload.sub}:${now}`,
    };
  }
}

/**
 * Development-only provider: the token IS the user id. Exists so the client and
 * the E2E script can run before packages/api mints real tokens. Refuses to be
 * constructed when NODE_ENV=production.
 */
export class DevAuthProvider implements AuthProvider {
  constructor() {
    if (isProduction()) throw new Error('DevAuthProvider is forbidden in production');
  }

  async authenticate(token: string): Promise<AuthIdentity> {
    const userId = (token || '').trim();
    if (!userId) throw new AuthError('missing_token', 'Token ausente');
    return {
      userId,
      displayName: `Cidadão ${userId.slice(0, 8)}`,
      permissions: ['play'],
      gifterLevel: 0,
      agency: '',
      sessionId: `${userId}:dev`,
    };
  }
}

/** Signs a dev token. Used by tests and by scripts/e2e-two-clients.mjs. */
export function signDevToken(secret: string, payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function defaultAuthProvider(): AuthProvider {
  if (config.authSecret) return new JwtAuthProvider(config.authSecret);
  if (isProduction()) {
    throw new Error('AUTH_JWT_SECRET is required in production');
  }
  if (!config.authDevBypass) {
    // Loud, because silently accepting any string is how staging becomes prod.
    console.warn('[auth] AUTH_JWT_SECRET vazio — usando DevAuthProvider. Defina AUTH_DEV_BYPASS=1 para silenciar.');
  }
  return new DevAuthProvider();
}
