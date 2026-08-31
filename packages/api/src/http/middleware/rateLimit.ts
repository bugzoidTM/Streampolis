import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.ts';

/**
 * Limitador de taxa em processo.
 *
 * Sem dependência nova de propósito: o que precisa existir ANTES de a API ver
 * a internet é um teto, não um produto. Janela fixa por chave, memória podada,
 * e três classes com tetos diferentes porque as rotas não valem o mesmo:
 *
 *   auth     — /auth/*: é onde se testa senha em massa. Teto baixo.
 *   economy  — carteira e extrato do próprio jogador. Teto médio.
 *   service  — /internal/*: um único chamador confiável (o game server) que
 *              legitimamente faz MUITA chamada — cada presente de cada live
 *              passa por ali. O teto existe como raio de explosão se o token de
 *              serviço vazar, não como portão: apertá-lo até o teto de usuário
 *              derrubaria o gifting da plataforma inteira num horário de pico.
 *   general  — o resto.
 *
 * Limitação conhecida e deliberada: o contador vive na memória do processo, e
 * portanto não é compartilhado entre réplicas. Com N réplicas o teto efetivo é
 * N vezes maior. Quando isso passar a importar, a contagem muda para o Redis
 * (SPECs §53) — a interface aqui não muda.
 */

export type RateClass = 'general' | 'auth' | 'economy' | 'service';

interface Bucket {
  count: number;
  /** Epoch ms em que a janela termina. */
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastPrune = 0;

/** Poda preguiçosa: sem isso um scanner de IPs vira um vazamento de memória. */
function prune(now: number): void {
  if (now - lastPrune < 30_000) return;
  lastPrune = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Chave do balde. `req.ip` respeita `trust proxy`, que precisa estar ligado
 * quando a API roda atrás de um reverse proxy — sem isso todo mundo compartilha
 * o IP do proxy e o teto vira global.
 */
function keyOf(req: Request, cls: RateClass): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  return `${cls}:${ip}`;
}

export function rateLimit(cls: RateClass) {
  const max = cls === 'auth'
    ? config.rateLimit.authMax
    : cls === 'economy'
      ? config.rateLimit.economyMax
      : cls === 'service'
        ? config.rateLimit.serviceMax
        : config.rateLimit.generalMax;

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    prune(now);

    const key = keyOf(req, cls);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + config.rateLimit.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}

/** Zera os contadores. Só para teste — nada em produção chama isto. */
export function resetRateLimits(): void {
  buckets.clear();
}
