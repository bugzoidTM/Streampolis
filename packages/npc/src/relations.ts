import { pool } from './db.js';
import { warn } from './log.js';

/**
 * As relações de um personagem social: com jogadores e com outros personagens.
 *
 * É o diferencial da classe: a vontade cabe numa caixa, mas as relações
 * crescem e esfriam com o que acontece — quem volta, quem conversa, quem é
 * grosseiro. Um número (`affinity`) e um estágio derivado dele decidem o tom
 * da fala, se ele aceita seguir alguém, se vai ao encontro de quem chegou.
 *
 * Persistência é write-behind: a linha muda na memória a cada evento e vai ao
 * banco de tempos em tempos (`flush`). Quinze personagens gravando a cada
 * "oi" seriam mais escrita que o resto do jogo junto, para um dado que
 * tolera perder os últimos segundos.
 */
export type Stage = 'grudge' | 'stranger' | 'known' | 'friend' | 'close';
export type OtherKind = 'player' | 'npc';

export interface Relation {
  otherId: string;
  otherKind: OtherKind;
  otherName: string;
  affinity: number;
  encounters: number;
  exchanges: number;
  /** Fatos que a pessoa disse de si ("é de Recife"), no máximo 5. */
  facts: string[];
  firstSeen: Date;
  lastSeen: Date;
  lastGreetedAt: number;
  /** Quanto a afinidade já subiu hoje por conversa (teto por dia). */
  gainToday: number;
  gainDay: string;
  dirty: boolean;
}

export const STAGE_MIN: Record<Exclude<Stage, 'grudge' | 'stranger'>, number> = { known: 6, friend: 20, close: 45 };
export const GRUDGE_MAX = -10;
/** Teto de afinidade ganho por conversa num dia com a mesma pessoa. */
export const DAILY_GAIN_CAP = 6;
const MAX_FACTS = 5;

export function stageOf(affinity: number): Stage {
  if (affinity <= GRUDGE_MAX) return 'grudge';
  if (affinity >= STAGE_MIN.close) return 'close';
  if (affinity >= STAGE_MIN.friend) return 'friend';
  if (affinity >= STAGE_MIN.known) return 'known';
  return 'stranger';
}

export const STAGE_ORDER: Stage[] = ['grudge', 'stranger', 'known', 'friend', 'close'];
export function atLeast(stage: Stage, min: Stage): boolean {
  return STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(min);
}

/**
 * Esfriamento pelo tempo sem se ver: afinidade positiva perde 3 % ao dia (menos
 * para quem é leal), e um ressentimento cede 1 ponto por dia. Aplicado ao
 * carregar — é quando o tempo passou.
 */
export function cooled(affinity: number, daysAway: number, loyal: number): number {
  if (daysAway <= 0) return affinity;
  if (affinity > STAGE_MIN.known) {
    const keep = Math.pow(1 - 0.03 * (1 - loyal * 0.6), daysAway);
    return Math.max(STAGE_MIN.known, affinity * keep);
  }
  if (affinity < 0) return Math.min(0, affinity + daysAway);
  return affinity;
}

interface Row {
  other_id: string; other_kind: OtherKind; other_name: string; affinity: number; encounters: number; exchanges: number;
  facts: string[]; first_seen: Date; last_seen: Date; last_greeted: Date | null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class Relations {
  private readonly cache = new Map<string, Relation>();
  private readonly loading = new Map<string, Promise<Relation>>();

  constructor(private readonly npcId: string, private readonly loyal: number) {}

  /** A relação com alguém, carregando do banco na primeira vez (ou criando). */
  async get(otherId: string, otherKind: OtherKind, otherName: string): Promise<Relation> {
    const hit = this.cache.get(otherId);
    if (hit) { hit.otherName = otherName; return hit; }
    let pending = this.loading.get(otherId);
    if (!pending) {
      pending = this.load(otherId, otherKind, otherName).finally(() => this.loading.delete(otherId));
      this.loading.set(otherId, pending);
    }
    return pending;
  }

  /** A relação se já estiver em memória; nula se nunca foi carregada nesta sessão. */
  peek(otherId: string): Relation | undefined {
    return this.cache.get(otherId);
  }

  all(): Relation[] {
    return [...this.cache.values()];
  }

  private async load(otherId: string, otherKind: OtherKind, otherName: string): Promise<Relation> {
    let row: Row | undefined;
    try {
      const r = await pool.query<Row>(
        `SELECT other_id, other_kind, other_name, affinity, encounters, exchanges, facts, first_seen, last_seen, last_greeted
           FROM npc_relations WHERE npc_id = $1 AND other_id = $2`,
        [this.npcId, otherId],
      );
      row = r.rows[0];
    } catch (err) {
      warn('relations', 'não carregou', { err: String(err) });
    }
    const now = new Date();
    let rel: Relation;
    if (row) {
      const daysAway = (now.getTime() - row.last_seen.getTime()) / 86_400_000;
      rel = {
        otherId, otherKind: row.other_kind, otherName,
        affinity: cooled(Number(row.affinity), daysAway, this.loyal),
        encounters: row.encounters, exchanges: row.exchanges, facts: row.facts ?? [],
        firstSeen: row.first_seen, lastSeen: row.last_seen,
        lastGreetedAt: row.last_greeted ? row.last_greeted.getTime() : 0,
        gainToday: 0, gainDay: today(), dirty: false,
      };
    } else {
      rel = {
        otherId, otherKind, otherName, affinity: 0, encounters: 0, exchanges: 0, facts: [],
        firstSeen: now, lastSeen: now, lastGreetedAt: 0, gainToday: 0, gainDay: today(), dirty: true,
      };
    }
    this.cache.set(otherId, rel);
    return rel;
  }

  /** Um reencontro: conta e reaproxima um pouco (mais para quem é leal). */
  meet(rel: Relation): void {
    rel.encounters++;
    rel.lastSeen = new Date();
    this.bump(rel, 0.5 + this.loyal * 0.5, false);
  }

  /**
   * Muda a afinidade. Ganho por CONVERSA tem teto diário por pessoa: sem isso
   * um jogador vira "amigo íntimo" em dez minutos de "oi" repetido — e a
   * relação deixa de significar tempo vivido.
   */
  bump(rel: Relation, delta: number, capped = true): Stage {
    const before = stageOf(rel.affinity);
    if (delta > 0 && capped) {
      const d = today();
      if (rel.gainDay !== d) { rel.gainDay = d; rel.gainToday = 0; }
      const room = Math.max(0, DAILY_GAIN_CAP - rel.gainToday);
      delta = Math.min(delta, room);
      rel.gainToday += delta;
    }
    rel.affinity = Math.max(-40, Math.min(80, rel.affinity + delta));
    rel.dirty = true;
    const after = stageOf(rel.affinity);
    return after !== before ? after : before;
  }

  exchanged(rel: Relation): void {
    rel.exchanges++;
    rel.lastSeen = new Date();
    rel.dirty = true;
  }

  greeted(rel: Relation): void {
    rel.lastGreetedAt = Date.now();
    rel.dirty = true;
  }

  learn(rel: Relation, fact: string): boolean {
    const f = fact.trim().slice(0, 80);
    if (!f || rel.facts.some((x) => x.toLowerCase() === f.toLowerCase())) return false;
    rel.facts.push(f);
    if (rel.facts.length > MAX_FACTS) rel.facts.splice(0, rel.facts.length - MAX_FACTS);
    rel.dirty = true;
    return true;
  }

  /** Grava o que mudou. Uma query por relação suja; normalmente zero ou uma. */
  async flush(): Promise<number> {
    let n = 0;
    for (const rel of this.cache.values()) {
      if (!rel.dirty) continue;
      rel.dirty = false;
      try {
        await pool.query(
          `INSERT INTO npc_relations (npc_id, other_id, other_kind, other_name, affinity, stage, encounters, exchanges, facts, first_seen, last_seen, last_greeted, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
           ON CONFLICT (npc_id, other_id) DO UPDATE SET
             other_name = EXCLUDED.other_name, affinity = EXCLUDED.affinity, stage = EXCLUDED.stage,
             encounters = EXCLUDED.encounters, exchanges = EXCLUDED.exchanges, facts = EXCLUDED.facts,
             last_seen = EXCLUDED.last_seen, last_greeted = EXCLUDED.last_greeted, updated_at = now()`,
          [
            this.npcId, rel.otherId, rel.otherKind, rel.otherName.slice(0, 64), Math.round(rel.affinity * 100) / 100, stageOf(rel.affinity),
            rel.encounters, rel.exchanges, rel.facts, rel.firstSeen, rel.lastSeen,
            rel.lastGreetedAt ? new Date(rel.lastGreetedAt) : null,
          ],
        );
        n++;
      } catch (err) {
        rel.dirty = true;
        warn('relations', 'não gravou', { err: String(err) });
        break;
      }
    }
    return n;
  }
}
