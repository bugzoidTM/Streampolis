import type { Weather } from './shared.js';
import { fold } from './text.js';

/**
 * FADIGA DE INTENÇÃO do personagem cognitivo.
 *
 * O soak de 15/09 mostrou o problema: em 10 h a Dalva foi "aos fundos do beco
 * observar o tambor" 14 vezes e "passear pela avenida parando nas poças" outras
 * 14 — cada vez com um "why" novo e sincero. O modelo não se lembra de que já
 * fez aquilo; o histórico no prompt ajuda pouco. Então a memória de curto prazo
 * vira CÓDIGO: repetir a mesma habilidade com o mesmo alvo (ou um objetivo
 * que diz a mesma coisa com outras palavras) dentro de uma janela recente é
 * penalizado — no prompt (o cansaço é dito) e no portão (o plano é recusado e
 * o modelo repensa uma vez). A exceção é uma mudança factual relevante no
 * mundo desde a última vez: choveu ou parou, virou noite ou dia, chegou
 * alguém que não estava. Voltar ao néon do clube porque começou a chover é
 * vida; voltar pela sétima vez na mesma chuva é fadiga.
 *
 * Nenhuma habilidade nova nasce aqui: a fadiga só escolhe ENTRE as que existem.
 */
export interface WorldSnapshot {
  weather: Weather | null;
  night: boolean | null;
  /** Quem (de verdade, não NPC) estava na cena — ids, poucos. */
  people: string[];
}

export interface PastIntention {
  goal: string;
  skill: string;
  params: Record<string, unknown>;
  startedAt: Date;
  world: WorldSnapshot | null;
}

export interface FatigueMatch {
  past: PastIntention;
  /** 'target' — mesma habilidade e mesmo alvo; 'goal' — objetivo equivalente com a mesma habilidade. */
  how: 'target' | 'goal';
  ageMin: number;
  /** Peso desta repetição no cansaço (decai com a idade); 0 quando o mundo mudou. */
  weight: number;
  /** O que mudou no mundo desde então (isenta), ou nulo. */
  changed: string | null;
}

export interface Fatigue {
  key: string;
  score: number;
  blocked: boolean;
  matches: FatigueMatch[];
}

export const FATIGUE = {
  /** Janela em que uma repetição ainda pesa. */
  windowMs: 2 * 60 * 60_000,
  /** Cansaço a partir do qual o plano é recusado: uma repetição a menos de meia janela já basta. */
  blockAt: 0.5,
  /** Jaccard mínimo entre os termos de dois objetivos para valerem como o mesmo. */
  goalSimilarity: 0.6,
  /** Quantas intenções recentes olhar (cobre a janela com folga: ~13 min cada). */
  lookback: 24,
} as const;

/**
 * A chave de alvo de um plano: a habilidade mais o que a torna "a mesma
 * coisa". Para as sem parâmetro (wander, stay, rest…) o alvo é a própria
 * habilidade. Segue os parâmetros já VALIDADOS (nome canônico do lugar).
 */
export function targetKey(skill: string, params: Record<string, unknown>): string {
  const p = params ?? {};
  switch (skill) {
    case 'go_to':
    case 'people_watch':
    case 'greet_arrivals':
      return typeof p.place === 'string' && p.place ? `${skill}:${fold(p.place)}` : skill;
    case 'patrol':
      return Array.isArray(p.places) ? `${skill}:${[...new Set(p.places.map((x) => fold(String(x))))].sort().join('|')}` : skill;
    case 'visit_poi':
      return typeof p.kind === 'string' ? `${skill}:${p.kind}` : skill;
    case 'queue_kiosk':
      return typeof p.kiosk === 'number' ? `${skill}:${p.kiosk}` : skill;
    case 'follow':
      return typeof p.userId === 'string' ? `${skill}:${p.userId}` : skill;
    default:
      return skill;
  }
}

/** Palavras que não distinguem um objetivo do outro (artigos, preposições, verbos de ir/ficar/olhar). */
const STOP = new Set(('a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas com sem para pra ate até e ou que se '
  + 'ir indo vou ate ficar fica ficando parar parando passar passando dar dando andar andando observar observando olhar olhando ver vendo '
  + 'visitar visitando esperar esperando caso quer queira continuar volta um pouco mais la lá ali aqui hoje agora enquanto sobre sob').split(' '));

/** Os termos que carregam o sentido de um objetivo, sem acento, caixa, plural simples nem vazio. */
export function goalTerms(goal: string): Set<string> {
  const out = new Set<string>();
  for (const raw of fold(goal).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (!raw || raw.length < 3 || STOP.has(raw)) continue;
    out.add(raw.endsWith('s') && raw.length > 4 ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** Jaccard entre os termos: 1 = mesmas palavras, 0 = nada em comum. */
export function goalSimilarity(a: string, b: string): number {
  const ta = goalTerms(a);
  const tb = goalTerms(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** O que mudou de fato no mundo entre um retrato e outro, em prosa curta — ou nulo se nada relevante. */
export function worldChange(then: WorldSnapshot | null, now: WorldSnapshot): string | null {
  if (!then) return null;
  const changes: string[] = [];
  if (then.weather && now.weather && then.weather !== now.weather) changes.push(now.weather === 'rain' ? 'começou a chover' : 'parou de chover');
  if (then.night !== null && now.night !== null && then.night !== now.night) changes.push(now.night ? 'anoiteceu' : 'amanheceu');
  const before = new Set(then.people);
  const newcomers = now.people.filter((id) => !before.has(id));
  if (newcomers.length) changes.push(newcomers.length === 1 ? 'chegou alguém que não estava' : `chegaram ${newcomers.length} pessoas que não estavam`);
  return changes.length ? changes.join(', ') : null;
}

/**
 * Quanto o personagem está cansado deste plano, dado o que fez há pouco.
 * Cada repetição na janela pesa `1 − idade/janela` (a de agora há pouco pesa
 * quase 1; a de quase duas horas atrás quase nada) — a menos que o mundo tenha
 * mudado desde ela, quando pesa zero e só fica registrada.
 */
export function assessFatigue(
  candidate: { goal: string; skill: string; params: Record<string, unknown> },
  recent: PastIntention[],
  world: WorldSnapshot,
  now: number,
): Fatigue {
  const key = targetKey(candidate.skill, candidate.params);
  const matches: FatigueMatch[] = [];
  for (const past of recent) {
    const ageMs = now - past.startedAt.getTime();
    if (ageMs < 0 || ageMs >= FATIGUE.windowMs) continue;
    let how: FatigueMatch['how'] | null = null;
    if (targetKey(past.skill, past.params) === key) how = 'target';
    else if (past.skill === candidate.skill && goalSimilarity(past.goal, candidate.goal) >= FATIGUE.goalSimilarity) how = 'goal';
    if (!how) continue;
    const changed = worldChange(past.world, world);
    matches.push({ past, how, ageMin: Math.round(ageMs / 60_000), weight: changed ? 0 : 1 - ageMs / FATIGUE.windowMs, changed });
  }
  const score = matches.reduce((s, m) => s + m.weight, 0);
  return { key, score, blocked: score >= FATIGUE.blockAt, matches };
}

/**
 * O cansaço para o prompt: por alvo, quantas vezes na janela e há quanto tempo
 * a última — o que o modelo precisa saber ANTES de escolher, para não gastar
 * uma resposta com o que o portão vai recusar.
 */
export function fatigueLines(recent: PastIntention[], world: WorldSnapshot, now: number): string[] {
  const byKey = new Map<string, { label: string; times: number; lastMin: number; tired: boolean }>();
  for (const past of recent) {
    const ageMs = now - past.startedAt.getTime();
    if (ageMs < 0 || ageMs >= FATIGUE.windowMs) continue;
    const key = targetKey(past.skill, past.params);
    const f = assessFatigue({ goal: past.goal, skill: past.skill, params: past.params }, recent, world, now);
    const cur = byKey.get(key) ?? { label: keyLabel(past.skill, past.params), times: 0, lastMin: Infinity, tired: false };
    cur.times++;
    cur.lastMin = Math.min(cur.lastMin, Math.round(ageMs / 60_000));
    cur.tired = cur.tired || f.blocked;
    byKey.set(key, cur);
  }
  return [...byKey.values()]
    .sort((a, b) => b.times - a.times || a.lastMin - b.lastMin)
    .map((c) => `- ${c.label}: ${c.times}× nas últimas ${Math.round(FATIGUE.windowMs / 60_000)} min (última há ${c.lastMin} min)${c.tired ? ' — CANSADO, não repita' : ' — só se algo mudou'}`);
}

/** Uma etiqueta legível do alvo ("go_to → Fundos do beco"). */
export function keyLabel(skill: string, params: Record<string, unknown>): string {
  const p = params ?? {};
  if (typeof p.place === 'string' && p.place) return `${skill} → ${p.place}`;
  if (Array.isArray(p.places)) return `${skill} → ${p.places.join(', ')}`;
  if (typeof p.kind === 'string') return `${skill} (${p.kind})`;
  if (typeof p.kiosk === 'number') return `${skill} (quiosque ${p.kiosk})`;
  return skill;
}
