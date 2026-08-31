import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../../config.ts';

/**
 * Duas portas, dois públicos:
 *
 *   requireUser    — token de sessão do jogador (SPECs §36).
 *   requireService — segredo compartilhado com o game server. Protege /internal,
 *                    que é onde dinheiro se move; uma rota dessas exposta ao
 *                    navegador seria a economia inteira aberta.
 */

export interface AuthedRequest extends Request {
  userId?: string;
  permissions?: string[];
}

export function requireUser(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }
  try {
    const payload = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
    }) as jwt.JwtPayload;
    if (typeof payload.sub !== 'string') {
      res.status(401).json({ error: 'bad_subject' });
      return;
    }
    req.userId = payload.sub;
    req.permissions = Array.isArray(payload.perms)
      ? payload.perms.filter((p): p is string => typeof p === 'string')
      : [];
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

export function requirePermission(permission: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.permissions?.includes(permission)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

/** Comparação em tempo constante: um `===` aqui vaza o segredo por timing. */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireService(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !sameSecret(token, config.serviceToken)) {
    res.status(401).json({ error: 'service_auth_required' });
    return;
  }
  next();
}
