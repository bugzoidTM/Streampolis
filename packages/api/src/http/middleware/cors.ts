import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.ts';

/**
 * CORS.
 *
 * O cliente roda num domínio (o site) e a API em outro (a API). Sem estes
 * cabeçalhos o navegador recusa a resposta ANTES de a tela ver qualquer coisa —
 * e o sintoma é traiçoeiro: nenhum erro no servidor, tudo 200 no log, e a
 * interface simplesmente vazia.
 *
 * Em produção a lista de origens é explícita. `*` só vale fora dela: um
 * curinga numa API que move dinheiro é convite para qualquer página chamar em
 * nome de quem tiver o token colado.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.header('origin');
  const allowed = resolveOrigin(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', allowed);
    // A resposta muda conforme a origem: sem isto um proxy guarda a resposta de
    // um site e serve para outro.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    res.status(allowed ? 204 : 403).end();
    return;
  }
  next();
}

function resolveOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (config.corsOrigins.length === 0) return config.isProd ? null : origin;
  return config.corsOrigins.includes(origin) ? origin : null;
}
