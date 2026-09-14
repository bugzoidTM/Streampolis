import { pool } from './db.js';
import type { AnimState, SceneId } from './shared.js';
import type { Point } from './walker.js';

/**
 * O elenco: quem existe, de que classe é e com que programa/personalidade.
 *
 * Tudo vem do banco (`npc_agents.kind` + `npc_agents.profile`), nunca de uma
 * lista no código: assim um personagem entra, sai ou muda de posto por um
 * UPDATE, e o painel vê o mesmo que o processo vê. O processo relê o elenco a
 * cada meio minuto (ver `index.ts`).
 */
export type NpcKind = 'cognitive' | 'social' | 'ambient';

export interface AgentRow {
  id: string;
  slug: string;
  displayName: string;
  sceneId: SceneId;
  kind: NpcKind;
  profile: AmbientProfile | SocialProfile | Record<string, never>;
  enabled: boolean;
}

// ------------------------------------------------------------- ambiente ---

/** Um passo do programa de um figurante. */
export type AmbientStep =
  /** Ficar num ponto, virado para `yaw`, por um tempo, numa postura. */
  | { do: 'stand'; at: Point; yaw?: number; secs: [number, number]; pose?: AnimState }
  /** Andar até um ponto (ou um destino qualquer da cena) e ficar ali um pouco. */
  | { do: 'walk'; to?: Point; secs?: [number, number] }
  /** Sentar numa vaga de banco perto de um ponto (só onde há bancos). */
  | { do: 'sit'; near?: Point; secs: [number, number] };

export interface AmbientProfile {
  /** O papel, como legenda para o painel ("porteiro do hotel"). */
  role: string;
  /** Programa cíclico. Um passo só = posto fixo. */
  program: AmbientStep[];
  /** Falas de balcão para quem o chama pelo nome. Vazio = mudo. */
  lines?: string[];
}

// --------------------------------------------------------------- social ---

/**
 * A personalidade em cinco números de 0 a 1. É a "caixa": tudo o que o
 * personagem social decide sai daqui, do humor e das relações — e de nada
 * mais. Dois personagens com os mesmos números na mesma situação fazem a
 * mesma coisa, o que é exatamente o que torna isso testável.
 */
export interface Personality {
  /** Procura gente ou espera que venham. */
  sociable: number;
  /** Anda para ver; pergunta. */
  curious: number;
  /** Humor de base. */
  cheerful: number;
  /** Aguenta grosseria e repetição. */
  patient: number;
  /** Apego a quem volta: relações sobem mais rápido e esfriam mais devagar. */
  loyal: number;
}

/** Como o personagem fala: escolhe o banco de frases (ver `speech.ts`). */
export type Archetype =
  | 'tagarela' | 'timido' | 'zoeiro' | 'sonhador' | 'pratico' | 'romantico'
  | 'rabugento' | 'misterioso' | 'malandro' | 'poeta' | 'festeiro' | 'fofoqueiro' | 'entusiasta';

export interface SocialProfile {
  archetype: Archetype;
  personality: Personality;
  /** Onde gosta de ficar (pontos livres da cena). */
  haunts: Point[];
  /** Como se apresenta quando perguntam quem é. Já diz que é personagem. */
  intro: string;
  /** Assuntos das falas espontâneas (frases completas, curtas). */
  topics: string[];
  /** Um bordão ocasional. */
  quirk?: string;
}

// ---------------------------------------------------------------- banco ---

interface Row {
  id: string; slug: string; display_name: string; scene_id: string; kind: NpcKind; profile: unknown; enabled: boolean;
}

/** Todo o elenco (habilitado ou não), na ordem de criação. */
export async function loadRoster(): Promise<AgentRow[]> {
  const { rows } = await pool.query<Row>(
    `SELECT id, slug, display_name, scene_id, kind, profile, enabled FROM npc_agents ORDER BY created_at, slug`,
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    displayName: r.display_name,
    sceneId: r.scene_id as SceneId,
    kind: r.kind,
    profile: (typeof r.profile === 'object' && r.profile !== null ? r.profile : {}) as AgentRow['profile'],
    enabled: r.enabled,
  }));
}

/** Freios: o geral e os por classe. Banco fora = mantém o que se sabia. */
export async function readFlags(previous: Record<string, boolean>): Promise<Record<string, boolean>> {
  try {
    const { rows } = await pool.query<{ key: string; enabled: boolean }>(
      `SELECT key, enabled FROM feature_flags WHERE key IN ('npc_enabled', 'npc_ambient_enabled', 'npc_social_enabled')`,
    );
    const out: Record<string, boolean> = { npc_enabled: true, npc_ambient_enabled: true, npc_social_enabled: true, ...previous };
    for (const r of rows) out[r.key] = r.enabled;
    return out;
  } catch {
    return previous;
  }
}

export function kindEnabled(kind: NpcKind, flags: Record<string, boolean>): boolean {
  if (flags.npc_enabled === false) return false;
  if (kind === 'ambient') return flags.npc_ambient_enabled !== false;
  if (kind === 'social') return flags.npc_social_enabled !== false;
  return true;
}
