import { keyLabel, targetKey } from './fatigue.js';
import type { IntentionRow } from './intentions.js';

/**
 * O RESUMO DE NOVIDADE que a deliberação recebe.
 *
 * A fadiga (`fatigue.ts`) recusa a repetição depois de escolhida. Este módulo
 * age ANTES: conta ao modelo, em prosa curta, o que ele já viu e o que rendeu
 * — lugares visitados (e se chegou e quanto ficou), o que repetiu, os
 * objetivos em que nada aconteceu, as interações que obteve — e o que ainda
 * não explorou. É só leitura do registro (`npc_intentions`, com as partes da
 * migration 0028); não decide nada.
 */
export const NOVELTY = {
  /** Janela do resumo: mais larga que a da fadiga, porque "ainda não explorado" é sobre o dia, não sobre a última hora. */
  windowMs: 6 * 60 * 60_000,
  /** Quantas intenções recentes buscar (cobre a janela com folga: ~13 min cada). */
  lookback: 40,
  maxLines: 6,
} as const;

/** Onde uma intenção quis ir, em nomes de lugar — vazio para as sem destino. */
export function placesOfIntention(skill: string, params: Record<string, unknown>): string[] {
  const p = params ?? {};
  if (typeof p.place === 'string' && p.place) return [p.place];
  if (Array.isArray(p.places)) return p.places.map((x) => String(x));
  if (skill === 'queue_kiosk' && typeof p.kiosk === 'number') return [`quiosque ${p.kiosk}`];
  return [];
}

/** "Nada aconteceu": sem interação com gente, sem evento no mundo e sem ter falhado (a falha é notícia). */
export function uneventful(r: IntentionRow): boolean {
  if (!r.endedAt) return false;
  if (r.outcome === 'failed') return false;
  const i = r.interactions;
  const social = r.exchanges > 0 || (i ? i.greetings > 0 || i.heard > 0 || i.nearby.length > 0 : false);
  return !social && !(r.events && r.events.length);
}

function ago(now: number, d: Date): number {
  return Math.max(0, Math.round((now - d.getTime()) / 60_000));
}

function fmtDur(sec: number): string {
  return sec < 90 ? `${sec} s` : `${Math.round(sec / 60)} min`;
}

export interface NoveltyInput {
  recent: IntentionRow[];
  /** O que existe na cena, para dizer o que ainda não foi explorado. */
  available: { places: string[]; skills: string[] };
  now: number;
}

/**
 * As linhas do bloco NOVIDADE, ou nenhuma se não há registro na janela.
 * Só intenções DELIBERADAS contam como experiência própria: as de conversa
 * foram pedido de alguém, as padrão são o passeio de espera.
 */
export function noveltyLines(input: NoveltyInput): string[] {
  const { now } = input;
  const rows = input.recent.filter((r) => r.source === 'deliberation' && now - r.startedAt.getTime() < NOVELTY.windowMs);
  if (!rows.length) return [];
  const hours = Math.round(NOVELTY.windowMs / 3_600_000);
  const out: string[] = [];

  // Lugares visitados: por lugar, quantas vezes, se chegou, quanto ficou.
  // `known`: linhas que têm o dado de chegada (as de antes da migration 0028 não têm — não é "não chegou").
  const visited = new Map<string, { times: number; known: number; arrived: number; dwell: number; lastMin: number }>();
  for (const r of rows) {
    for (const place of placesOfIntention(r.skill, r.params)) {
      const cur = visited.get(place) ?? { times: 0, known: 0, arrived: 0, dwell: 0, lastMin: Infinity };
      cur.times++;
      if (r.arrived !== null) cur.known++;
      if (r.arrived) cur.arrived++;
      cur.dwell += r.dwellSec ?? 0;
      cur.lastMin = Math.min(cur.lastMin, ago(now, r.startedAt));
      visited.set(place, cur);
    }
  }
  if (visited.size) {
    const parts = [...visited.entries()]
      .sort((a, b) => b[1].times - a[1].times || a[1].lastMin - b[1].lastMin)
      .slice(0, 8)
      .map(([place, v]) => `${place} (${v.times}×, última há ${v.lastMin} min${v.arrived ? `, chegou ${v.arrived}×, ficou ${fmtDur(Math.round(v.dwell / v.arrived))} em média` : v.known ? ', NÃO chegou' : ''})`);
    out.push(`- Lugares visitados nas últimas ${hours} h: ${parts.join('; ')}.`);
  }

  // Repetições: o mesmo alvo mais de uma vez.
  const byKey = new Map<string, { label: string; times: number }>();
  for (const r of rows) {
    const key = targetKey(r.skill, r.params);
    const cur = byKey.get(key) ?? { label: keyLabel(r.skill, r.params), times: 0 };
    cur.times++;
    byKey.set(key, cur);
  }
  const repeated = [...byKey.values()].filter((k) => k.times >= 2).sort((a, b) => b.times - a.times);
  if (repeated.length) out.push(`- Repetições: ${repeated.slice(0, 6).map((k) => `${k.label} ${k.times}×`).join('; ')}.`);

  // Objetivos sem novidade: nada aconteceu, ninguém apareceu.
  const flat = rows.filter(uneventful);
  if (flat.length) {
    out.push(`- Objetivos SEM novidade (nada aconteceu, ninguém apareceu): ${flat.slice(0, 5).map((r) => `"${r.goal}"`).join('; ')}${flat.length > 5 ? ` e mais ${flat.length - 5}` : ''}.`);
  }

  // Interações obtidas: o que rendeu gente.
  const social = rows.filter((r) => r.exchanges > 0 || (r.interactions && (r.interactions.greetings > 0 || r.interactions.nearby.length > 0)));
  if (social.length) {
    const parts = social.slice(0, 5).map((r) => {
      const i = r.interactions;
      const who = i ? [...new Set([...i.spokeWith, ...i.nearby])].slice(0, 4) : [];
      const bits = [
        r.exchanges ? `${r.exchanges} conversa(s)` : null,
        i?.greetings ? `${i.greetings} cumprimento(s)` : null,
        who.length ? `com ${who.join(', ')}` : null,
      ].filter(Boolean);
      return `${keyLabel(r.skill, r.params)} há ${ago(now, r.startedAt)} min: ${bits.join(', ')}`;
    });
    out.push(`- Interações que você obteve: ${parts.join('; ')}.`);
  } else {
    out.push(`- Interações que você obteve nas últimas ${hours} h: nenhuma.`);
  }

  // Ainda não explorado: lugares e habilidades sem uso na janela.
  const usedSkills = new Set(rows.map((r) => r.skill));
  const unexploredPlaces = input.available.places.filter((p) => !visited.has(p));
  const unexploredSkills = input.available.skills.filter((s) => !usedSkills.has(s));
  const parts: string[] = [];
  if (unexploredPlaces.length) parts.push(`lugares: ${unexploredPlaces.slice(0, 8).join(', ')}`);
  if (unexploredSkills.length) parts.push(`habilidades: ${unexploredSkills.join(', ')}`);
  out.push(parts.length ? `- Ainda NÃO explorado nas últimas ${hours} h — ${parts.join('; ')}.` : `- Você já explorou todos os lugares e habilidades nas últimas ${hours} h.`);

  return out.slice(0, NOVELTY.maxLines);
}
