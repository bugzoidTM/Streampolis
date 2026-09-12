import { config } from './config.js';

export interface NpcIdentity {
  token: string;
  expiresIn: number;
  npc: { id: string; slug: string; displayName: string; sceneId: string; enabled: boolean };
}

/**
 * A identidade vem da API, assinada — o worker nunca tem o segredo do JWT.
 * É o que mantém a fronteira: só a API emite a permissão `npc`, e o game
 * server não tem como distinguir este processo de um navegador, o que é
 * exatamente o ponto.
 */
export async function fetchIdentity(): Promise<NpcIdentity> {
  const res = await fetch(`${config.apiBaseUrl}/internal/npc/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiServiceToken}`,
    },
    body: JSON.stringify({ npc: config.npcSlug }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`token do personagem: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as NpcIdentity;
}
