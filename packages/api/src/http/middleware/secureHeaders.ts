import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config.ts';

/**
 * Cabeçalhos de segurança (SPECs §37, onde eles aparecem como OBRIGATÓRIOS).
 *
 * A API não mandava nenhum. Não é o buraco mais dramático de uma lista de
 * segurança — HTTPS, JWT, rate limit, SQL parametrizado e verificação de
 * assinatura de webhook já estavam de pé —, mas é o mais barato de fechar, e
 * cada linha aqui desliga uma classe inteira de ataque no navegador.
 *
 * O que cada um faz, e por que este valor:
 *
 *   * **X-Content-Type-Options: nosniff** — o navegador para de adivinhar o
 *     tipo do conteúdo. Sem isso, um JSON com HTML dentro pode ser executado
 *     como página;
 *   * **X-Frame-Options: DENY** — ninguém coloca a API dentro de um iframe.
 *     Numa API que move dinheiro, clickjacking é o ataque óbvio;
 *   * **Referrer-Policy: no-referrer** — nenhuma URL nossa vaza para o site
 *     seguinte. As nossas carregam id de usuário e de sala no caminho;
 *   * **Cross-Origin-Resource-Policy: same-site** — outro site não embute a
 *     resposta desta API como recurso;
 *   * **Permissions-Policy** — a API não precisa de câmera, microfone nem
 *     geolocalização, e dizer isso explicitamente é de graça;
 *   * **Content-Security-Policy: default-src 'none'** — a API só devolve JSON.
 *     Uma política vazia é a correta aqui: nada para carregar, nada para
 *     executar. (A política do SITE é outra, e mora no nginx dele.)
 *
 * **HSTS só em produção e só sob HTTPS.** Mandar `Strict-Transport-Security`
 * de um ambiente que roda em `http://127.0.0.1` treina o navegador do
 * desenvolvedor a recusar o próprio localhost por meses — e o navegador não
 * esquece porque a gente pediu desculpa.
 */
export function secureHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  // `x-forwarded-proto` só é confiável porque há um proxy declarado à frente
  // (API_TRUST_PROXY); sem proxy, o header é chute de quem chamou.
  const viaHttps = req.secure
    || (config.trustProxy > 0 && req.get('x-forwarded-proto') === 'https');
  if (config.isProd && viaHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}
