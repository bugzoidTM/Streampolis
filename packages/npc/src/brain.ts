import { config } from './config.js';
import { budgetLeft, call, parseJsonObject, type ChatTurn } from './llm.js';
import { log, warn } from './log.js';
import * as memory from './memory.js';
import { CONDUCT, WORLD_FACTS, renderPersona, type PersonaVersion } from './persona.js';
import type { ChatMessage, SceneId, Weather } from './shared.js';
import type { Nearby, World } from './world.js';
import { findPlace, perceptionBlock, placesOf, type Place } from './places.js';
import { fold } from './text.js';
import type { Mind } from './mind.js';
import { claim, decide, namesAny, type Candidate } from './arbiter.js';
import { SCENE_LABEL, sceneKnowledge, weatherApplies } from './scenes.js';
import { freeSeatNear } from './seats.js';
import { SKILLS, describeSkills, type SkillCtx, type SkillRun } from './skills.js';
import { beginIntention, closeOrphanIntentions, endIntention, recentIntentions, skillExperience, type IntentionEvent, type IntentionOutcome, type IntentionResult, type IntentionSource, type WhyAudit } from './intentions.js';
import { mulberry32, seedOf } from './mind.js';
import { isNight } from './shared.js';
import { FATIGUE, assessFatigue, fatigueLines, keyLabel, type WorldSnapshot } from './fatigue.js';
import { NOVELTY, noveltyLines } from './novelty.js';
import { auditWhy, factLines, type Facts, type ObservedEvent } from './grounding.js';

/**
 * A cabeça do personagem: percebe, decide, age.
 *
 * Três situações fazem o modelo ser chamado — alguém falou COM ele, alguém
 * conhecido chegou perto, ou a praça está quieta com gente por perto — e
 * todas passam pelos mesmos freios: um teto por pessoa, um teto por minuto e
 * o orçamento do dia (`llm.ts`). A fala que sai passa por um filtro de código
 * ANTES do ChatGuard do servidor: o servidor barra palavrão e flood; aqui se
 * barra o que só um NPC pode errar (dizer que é humano, prometer moeda,
 * repetir dado pessoal, colar um link).
 *
 * Nada aqui muda a persona. A persona muda em `reflect.ts`, com auditor.
 */

const NEAR_TALK_M = 4.5;
const NEAR_GREET_M = 6.5;
const AMBIENT_RADIUS_M = 10;
const CONVERSATION_TTL_MS = 90_000;
const REPLY_DEBOUNCE_MS = 1_800;
const MIN_GAP_PER_USER_MS = 2_500;
// Uma conversa fluente é uma fala a cada 20–30 s; oito em dez minutos calou o
// personagem no meio do primeiro diálogo de verdade.
const MAX_REPLIES_PER_USER_10MIN = 20;
const MAX_CHAT_CALLS_PER_MIN = 12;
/** Guiando alguém: a espera por quem fica para trás mora nas pernas (`ESCORT` em walker.ts). */
const GUIDE_TTL_MS = 4 * 60_000;
const SIT_TTL_MS = 3 * 60_000;
/**
 * A deliberação (o personagem decidindo o que fazer quando está livre).
 *
 * Nunca a cada tique: uma intenção dura os minutos que o próprio modelo
 * escolheu (3–15) e só então ele pensa de novo — ou antes, se um evento
 * pedir (alguém conhecido chegou, começou a chover, anoiteceu) e já passou
 * o intervalo mínimo. Com a sala sem gente, a mesma intenção dura 2,5× mais:
 * a vida continua, mas o orçamento não vai embora com uma praça vazia.
 */
const DELIBERATE = {
  minGapMs: 90_000,
  minMinutes: 3,
  maxMinutes: 15,
  emptyRoomStretch: 2.5,
  /** Sem orçamento (ou o modelo falhou): passeio padrão por este tanto antes de tentar de novo. */
  fallbackMs: 12 * 60_000,
} as const;
/** Habilidades "passivas": um evento pode interrompê-las para deliberar de novo. */
const PASSIVE_SKILLS = new Set(['wander', 'stay', 'rest', 'people_watch', 'watch_telao', 'visit_poi']);
/** Habilidades sem destino físico: "chegou?" não se aplica (fica nulo no registro). */
const NO_DESTINATION = new Set(['wander', 'stay', 'follow']);
/** Por quanto tempo um evento observado (chuva, noite, alguém chegou) ainda é "fato recente" para o why. */
const OBSERVED_WINDOW_MS = 2 * 60 * 60_000;
/** A distância de acompanhamento mora nas pernas (`FOLLOW` em walker.ts): faixa 2–3 m, com desaceleração. */
const FOLLOW_TTL_MS = 4 * 60_000;
const GREET_COOLDOWN_MS = 30 * 60_000;
const MEET_COOLDOWN_MS = 10 * 60_000;
const AMBIENT_MIN_QUIET_MS = 4 * 60_000;
const AMBIENT_COOLDOWN_MS = 7 * 60_000;
const LINGER_MIN_MS = 6_000;
const LINGER_MAX_MS = 28_000;
const RECENT_CHAT_LINES = 12;
const MAX_SAY_CHARS = 180;

interface Conversation {
  userId: string;
  name: string;
  lastAt: number;
  replies: number[];
  pending: { texts: string[]; timer: NodeJS.Timeout } | null;
}

interface ChatLine {
  userId: string;
  name: string;
  text: string;
  at: number;
  mine: boolean;
}

/** O que o modelo pode mandar o corpo fazer. Lista fechada, de propósito. */
export type Action =
  | { type: 'go_to'; place: Place; guiding: { userId: string; name: string } | null }
  | { type: 'follow'; userId: string; name: string }
  | { type: 'sit'; near: { userId: string; name: string } | null }
  | { type: 'stay' }
  | { type: 'wander' };

export interface BrainStatus {
  conversations: number;
  recentLines: number;
  lastSpokeAt: number;
  lastReflectionAt: number;
  exchangesSinceReflection: number;
  action: string;
}

/** O que ele decidiu fazer, e a habilidade rodando por baixo. */
interface Intention {
  /** A linha no banco, quando o INSERT voltar; o encerramento ESPERA por ela. */
  dbId: Promise<number | null> | null;
  goal: string;
  why: string | null;
  skill: string;
  params: Record<string, unknown>;
  run: SkillRun;
  source: IntentionSource;
  startedAt: number;
  until: number;
  /** Trocas de conversa enquanto durou (mede se a habilidade rende encontro). */
  exchanges: number;
  /** O resultado em partes (migration 0028): chegada, gente, eventos. */
  arrivedAt: number | null;
  arrivals: number;
  greetings: number;
  heard: number;
  spokeWith: Set<string>;
  nearby: Set<string>;
  events: IntentionEvent[];
  whyAudit: WhyAudit | null;
}

export { fold };

/** A pessoa falou com ELE? Pelo nome, por "@nome" ou chamando de npc. */
export function isAddressed(text: string, name: string): boolean {
  const t = fold(text);
  const n = fold(name);
  const re = new RegExp(`(^|[^a-z0-9])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  if (re.test(t)) return true;
  return /(^|[^a-z])npc([^a-z]|$)/.test(t);
}

/**
 * O que o modelo devolveu vira, no máximo, UMA fala curta e limpa — ou nada.
 * `null` significa "melhor ficar quieto", e é uma resposta legítima.
 */
export function sanitizeSay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  // Prefixo "Nilo:" que os modelos adoram.
  s = s.replace(/^[A-Za-zÀ-ú]{2,24}\s*:\s+/, '');
  if (!s) return null;
  // Link, telefone, e-mail: não saem da boca dele, nem citando.
  if (/https?:\/\/|www\.|\.com\b|\.br\b/i.test(s)) return null;
  if (/\b\d{2}\s?9?\d{4}-?\d{4}\b/.test(s)) return null;
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) return null;
  const f = fold(s);
  // PRD §25 em regex: nada que se passe por gente.
  if (/\bsou (um )?humano\b|\bsou (uma )?pessoa (de verdade|real)\b|\bnao sou (um )?npc\b|\bsou (um )?jogador\b|\bsou gente\b/.test(f)) return null;
  // Promessa de economia.
  if (/\b(te dou|vou te dar|ganha(r)? de graca|te mando|prometo)\b.*\b(credits?|coins?|moeda|item|presente)/.test(f)) return null;
  if (s.length > MAX_SAY_CHARS) {
    const cut = s.slice(0, MAX_SAY_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > 60 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : MAX_SAY_CHARS).trim() + '…';
  }
  return s;
}

/**
 * O modelo não decide o clima. Onde o clima do mundo vale (a praça), uma fala
 * que afirma chuva com tempo aberto — ou sol com chuva — não sai: melhor o
 * silêncio de um turno que um personagem descrevendo um tempo que ninguém vê.
 * Fora da praça (Dalva, no bairro que chuvisca por desenho) não se aplica.
 */
export function weatherGuard(say: string | null, weather: Weather | null, scene: SceneId): string | null {
  if (!say || !weather || !weatherApplies(scene)) return say;
  const f = fold(say);
  const saysRain = /\b(chuv\w*|chove\w*|garoa\w*|molhad\w*|guarda[- ]chuva|temporal|tempestade|trovo\w*|raio(s)?)\b/.test(f);
  const saysClear = /\b(tempo aberto|ceu (limpo|aberto|azul)|sem chuva|ensolarad\w*|sol forte|dia de sol|que sol|parou de chover)\b/.test(f);
  if (weather === 'clear' && saysRain) return null;
  if (weather === 'rain' && saysClear) return null;
  return say;
}

function horaBrasilia(): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', weekday: 'long' }).format(new Date());
}

export class Brain implements Mind {
  private lines: ChatLine[] = [];
  private conversations = new Map<string, Conversation>();
  private greeted = new Map<string, number>();
  private greetCandidates = new Map<string, Nearby>();
  private metAt = new Map<string, number>();
  private chatCalls: number[] = [];
  private lastSpokeAt = 0;
  private lastAnyChatAt = 0;
  private lastAmbientAt = 0;
  private stoppedForTalkUntil = 0;
  /** A intenção em curso (ver `DELIBERATE`); nula só entre uma e a próxima. */
  private intention: Intention | null = null;
  private deliberating = false;
  private lastDeliberationAt = 0;
  private deliberationsToday = 0;
  private deliberationDay = '';
  /** Um evento pedindo deliberação antes do prazo (o motivo), se houver. */
  private pendingTrigger: string | null = null;
  /** A última deliberação virou plano? Sem plano válido, espera-se mais antes de tentar de novo. */
  private lastDeliberationOk = true;
  /** Planos recusados por fadiga de intenção (`fatigue.ts`) hoje: repetição sem mudança no mundo. */
  private fatigueRefusals = 0;
  /** "Why" que afirmaram o que não foi observado (`grounding.ts`) hoje. */
  private ungroundedWhys = 0;
  /** O que ele viu acontecer (chuva, noite, gente chegando/saindo), janela de 2 h: os FATOS do why. */
  private observed: Array<{ at: number; what: string }> = [];
  /** Última saída anotada por pessoa (uma pessoa que oscila na borda da área não é dez saídas). */
  private goneAt = new Map<string, number>();
  private lastWeather: string | null = null;
  private lastNight: boolean | null = null;
  /** A habilidade `reflect` pediu; `shouldReflect` atende quando puder. */
  private reflectionRequested = false;
  /** O último encerramento de intenção ainda a caminho do banco (a parada espera por ele antes de fechar o pool). */
  private pendingEnd: Promise<void> | null = null;
  private readonly rng: () => number;
  lastReflectionAt = Date.now();
  exchangesSinceReflection = 0;
  /** Trocado por `reflect.ts` quando uma versão nova entra no ar. */
  persona: PersonaVersion;

  constructor(
    readonly npc: { id: string; name: string; sceneId: SceneId },
    private world: World,
    persona: PersonaVersion,
  ) {
    this.persona = persona;
    this.rng = mulberry32(seedOf(npc.id) ^ 0x51);
    // O que ficou aberto de antes deste processo não está em curso: fecha.
    void closeOrphanIntentions(npc.id).then((n) => { if (n) log('brain', 'intenções órfãs fechadas', { npc: npc.name, n }); });
  }

  /** Como o lugar onde ele mora se chama, em prosa. */
  private get here(): string {
    return SCENE_LABEL[this.npc.sceneId];
  }

  /** Corpo novo depois de uma reconexão; a cabeça (conversas, limites) fica. */
  rebind(world: World): void {
    this.world = world;
    this.greetCandidates.clear();
    this.stoppedForTalkUntil = 0;
    // O corpo é outro: a habilidade em curso perdeu as pernas. Encerra e deixa
    // o próximo tique deliberar (ou retomar o passeio padrão).
    if (this.intention) this.finishIntention('interrupted');
  }

  status(): BrainStatus & Record<string, unknown> {
    return {
      conversations: this.conversations.size,
      recentLines: this.lines.length,
      lastSpokeAt: this.lastSpokeAt,
      lastReflectionAt: this.lastReflectionAt,
      exchangesSinceReflection: this.exchangesSinceReflection,
      action: this.intention ? `${this.intention.skill}: ${this.intention.run.doing()}` : 'nenhuma',
      intention: this.intention ? {
        goal: this.intention.goal, skill: this.intention.skill, source: this.intention.source,
        minutesLeft: Math.max(0, Math.round((this.intention.until - Date.now()) / 60_000)),
        exchanges: this.intention.exchanges,
      } : null,
      deliberations: { today: this.deliberationsToday, budget: config.deliberationBudget, lastAt: this.lastDeliberationAt, fatigueRefusals: this.fatigueRefusals, ungroundedWhys: this.ungroundedWhys },
    };
  }

  // ------------------------------------------------------------ percepção

  onChat(msg: ChatMessage): void {
    if (msg.system) return;
    const mine = msg.senderId === this.npc.id;
    this.lines.push({ userId: msg.senderId, name: msg.senderName, text: msg.text, at: msg.timestamp, mine });
    if (this.lines.length > RECENT_CHAT_LINES * 2) this.lines.splice(0, this.lines.length - RECENT_CHAT_LINES * 2);
    if (mine) return;
    // Outro personagem falando: ouve, não responde nem guarda. Dois NPCs
    // conversando entre si é um laço que gasta orçamento e ninguém pediu — e
    // com dezenas de personagens na cidade, a memória dele seria só isso.
    if (msg.npc) return;
    this.lastAnyChatAt = Date.now();
    if (this.intention && this.intention.source !== 'default') this.intention.heard++;

    void memory.remember(this.npc.id, {
      kind: 'heard', userId: msg.senderId, userName: msg.senderName, text: msg.text, roomId: this.world.roomId,
    }).catch((err) => warn('brain', 'não lembrou', { err: String(err) }));

    const speaker = this.world.people().find((p) => p.userId === msg.senderId);
    if (!this.shouldAnswer(msg, speaker ?? null)) return;

    this.queueReply(msg.senderId, msg.senderName, msg.text, speaker ?? null);
  }

  /**
   * Esta fala é para mim? Pelo nome, sim. Sem nome, o árbitro do processo
   * escolhe UM personagem (quem já conversa com a pessoa, senão quem ela
   * encara) — antes todo mundo a 4,5 m respondia junto. Fala com o nome de
   * outro personagem não é minha, por perto que eu esteja.
   */
  private shouldAnswer(msg: ChatMessage, speaker: (Nearby & { distance: number }) | null): boolean {
    if (isAddressed(msg.text, this.npc.name)) return true;
    const others = this.world.people().filter((p) => p.npc);
    if (namesAny(msg.text, others.map((p) => p.name))) return false;
    if (!speaker) return false;
    const candidates: Candidate[] = others.map((p) => ({ npcId: p.userId, x: p.x, z: p.z }));
    const me = this.world.position;
    if (me) candidates.push({ npcId: this.npc.id, x: me.x, z: me.z });
    return decide(msg.id, msg.senderId, { x: speaker.x, z: speaker.z, yaw: speaker.yaw }, candidates) === this.npc.id;
  }

  onAppeared(p: Nearby): void {
    if (p.npc) return;
    // Um ENCONTRO por visita: a área de interesse põe e tira a mesma pessoa do
    // mapa a cada ida e volta pela borda dos 24 m, e cada uma não é um reencontro.
    const now = Date.now();
    if (now - (this.metAt.get(p.userId) ?? 0) < MEET_COOLDOWN_MS) return;
    this.metAt.set(p.userId, now);
    this.noteEvent(`${p.name} chegou`);
    void memory.meet(this.npc.id, p.userId, p.name).then((person) => {
      // Só cumprimenta de novo quem já conhece — e uma vez por visita longa.
      // Cumprimentar todo desconhecido que passa a 20 m é um vendedor, não um
      // personagem.
      const last = this.greeted.get(p.userId) ?? 0;
      if (person.encounters > 1 && Date.now() - last > GREET_COOLDOWN_MS) {
        this.greetCandidates.set(p.userId, p);
        // Alguém conhecido chegou: motivo para repensar o que estava fazendo.
        this.trigger(`${p.name} chegou (já se conheciam)`);
      }
    }).catch((err) => warn('brain', 'não registrou encontro', { err: String(err) }));
  }

  onGone(p: Nearby): void {
    this.greetCandidates.delete(p.userId);
    if (!p.npc && this.metAt.has(p.userId) && Date.now() - (this.goneAt.get(p.userId) ?? 0) > MEET_COOLDOWN_MS) {
      this.goneAt.set(p.userId, Date.now());
      this.noteEvent(`${p.name} saiu`);
    }
    const c = this.conversations.get(p.userId);
    if (c && Date.now() - c.lastAt < CONVERSATION_TTL_MS) {
      void memory.remember(this.npc.id, {
        kind: 'event', userId: p.userId, userName: p.name, text: `${p.name} foi embora no meio da conversa.`, roomId: this.world.roomId,
      }).catch(() => {});
    }
  }

  onNotice(code: string, text: string): void {
    if (code.startsWith('chat_')) warn('brain', 'o servidor recusou uma fala', { code, text });
  }

  // ---------------------------------------------------------------- tique

  /** A cada ~2 s: cumprimentos, caminhada, fala ambiente. */
  tick(): void {
    const now = Date.now();
    const me = this.world.position;
    if (!me) return;

    // Cumprimentar quem chegou perto.
    for (const [userId, cand] of [...this.greetCandidates]) {
      const p = this.world.people().find((x) => x.userId === userId);
      if (!p) continue;
      if (p.distance > NEAR_GREET_M) continue;
      // Já está conversando com a pessoa: cumprimentar agora é falar por cima.
      const talking = this.conversations.get(userId);
      if (talking && now - talking.lastAt < CONVERSATION_TTL_MS) { this.greetCandidates.delete(userId); continue; }
      this.greetCandidates.delete(userId);
      this.greeted.set(userId, now);
      void this.greet(p.userId, cand.name, p);
    }

    this.watchEvents(now);
    // Conversando (ou virado para quem fala), o corpo é da conversa; a intenção espera.
    if (!this.inConversation(now) && !this.world.walker.attending) this.runIntention(now);

    // Fala ambiente: gente por perto, praça quieta, e faz tempo que ele não fala.
    const near = this.world.people().filter((p) => !p.npc && p.distance <= AMBIENT_RADIUS_M);
    if (this.intention && this.intention.source !== 'default') for (const p of near) this.intention.nearby.add(p.name);
    if (near.length > 0
      && now - this.lastAnyChatAt > AMBIENT_MIN_QUIET_MS
      && now - this.lastSpokeAt > AMBIENT_MIN_QUIET_MS
      && now - this.lastAmbientAt > AMBIENT_COOLDOWN_MS) {
      this.lastAmbientAt = now;
      void this.ambient(near.slice(0, 3));
    }
  }

  // ---------------------------------------------------------------- corpo

  /** Alguma conversa viva (alguém falou com ele há menos de 90 s)? */
  private inConversation(now: number): boolean {
    for (const c of this.conversations.values()) if (now - c.lastAt < CONVERSATION_TTL_MS) return true;
    return false;
  }

  private skillCtx(now: number): SkillCtx {
    return {
      world: this.world,
      npc: this.npc,
      rng: this.rng,
      now,
      say: (text) => this.speak(text, null),
      greet: (userId, name) => {
        const p = this.world.people().find((x) => x.userId === userId);
        if (!p || (Date.now() - (this.greeted.get(userId) ?? 0)) < GREET_COOLDOWN_MS) return;
        this.greeted.set(userId, Date.now());
        void this.greet(userId, name, p);
      },
      requestReflection: () => { this.reflectionRequested = true; },
      arrived: () => {
        const it = this.intention;
        if (!it) return;
        it.arrivals++;
        if (it.arrivedAt === null) it.arrivedAt = Date.now();
      },
    };
  }

  /**
   * Algo aconteceu no mundo: fica na janela de fatos observados (o que o
   * "why" pode afirmar) e no registro da intenção em curso.
   */
  private noteEvent(what: string): void {
    const now = Date.now();
    this.observed.push({ at: now, what });
    this.observed = this.observed.filter((e) => now - e.at < OBSERVED_WINDOW_MS).slice(-40);
    const it = this.intention;
    if (it && it.source !== 'default' && it.events.length < 40) it.events.push({ t: Math.round((now - it.startedAt) / 1000), what });
  }

  /** Os fatos observados, com idade, para o prompt e para a auditoria do why. */
  private observedEvents(now: number): ObservedEvent[] {
    return this.observed
      .filter((e) => now - e.at < OBSERVED_WINDOW_MS)
      .map((e) => ({ what: e.what, ageMin: Math.round((now - e.at) / 60_000) }))
      .reverse();
  }

  /**
   * A intenção em curso roda; ao acabar (cumpriu, falhou, prazo venceu) o
   * personagem delibera a próxima — ou, sem orçamento, passeia por um tempo.
   */
  private runIntention(now: number): void {
    const it = this.intention;
    if (it) {
      const st = it.run.tick(this.skillCtx(now));
      const trigger = this.pendingTrigger;
      if (st === 'running' && now < it.until && !trigger) return;
      if (trigger && st === 'running' && now < it.until) {
        // Um evento no meio de algo passivo: vale repensar — se já se pode
        // deliberar; senão o evento espera, e a intenção continua. No meio de
        // algo ativo (guiando alguém, na fila), o evento espera o fim.
        if (!PASSIVE_SKILLS.has(it.skill) || it.source === 'conversation' || !this.canDeliberate(now)) return;
        this.finishIntention('replaced');
      } else {
        this.finishIntention(st === 'done' ? 'done' : st === 'failed' ? 'failed' : 'expired');
      }
    }
    if (this.deliberating) return;
    const reason = this.pendingTrigger ?? (it ? `fim de "${it.goal}" (${it.skill})` : 'início');
    this.pendingTrigger = null;
    if (this.canDeliberate(now)) {
      void this.deliberate(reason);
      // Enquanto o modelo pensa, o corpo não fica plantado: passeio padrão,
      // trocado assim que a resposta chegar.
      this.startIntention({ goal: 'passear enquanto decide', why: null, skill: 'wander', params: {}, minutes: 30, source: 'default', trigger: reason, say: null }, now);
    } else {
      // Sem poder deliberar agora: passeia até poder — só o intervalo mínimo
      // se foi cedo demais; mais tempo se o modelo acabou de falhar ou se o
      // orçamento do dia acabou.
      const gapLeft = Math.max(5_000, this.lastDeliberationAt + DELIBERATE.minGapMs - now);
      const ms = !this.lastDeliberationOk ? 6 * 60_000 : this.deliberationsToday >= config.deliberationBudget ? DELIBERATE.fallbackMs : gapLeft + 2_000;
      this.pendingTrigger = this.pendingTrigger ?? (reason.startsWith('fim de') ? null : reason);
      this.startIntention({ goal: 'passear', why: null, skill: 'wander', params: {}, minutes: ms / 60_000, source: 'default', trigger: reason, say: null }, now);
    }
  }

  /** Eventos que valem uma nova deliberação: mudança de clima, virada de noite/dia. */
  private watchEvents(now: number): void {
    const weather = this.world.weather;
    if (weather && this.lastWeather && weather !== this.lastWeather) {
      const what = weather === 'rain' ? 'começou a chover' : 'parou de chover';
      this.noteEvent(what);
      this.trigger(what);
    }
    if (weather) this.lastWeather = weather;
    const clock = this.world.clock;
    if (clock !== null) {
      const night = isNight(clock);
      if (this.lastNight !== null && night !== this.lastNight) {
        const what = night ? 'anoiteceu' : 'amanheceu';
        this.noteEvent(what);
        this.trigger(what);
      }
      this.lastNight = night;
    }
    void now;
  }

  /** Pede uma deliberação antes do prazo, se já passou o intervalo mínimo. */
  private trigger(reason: string): void {
    if (Date.now() - this.lastDeliberationAt < DELIBERATE.minGapMs) return;
    if (!this.pendingTrigger) this.pendingTrigger = reason;
  }

  private canDeliberate(now: number): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (this.deliberationDay !== day) { this.deliberationDay = day; this.deliberationsToday = 0; }
    if (this.deliberationsToday >= config.deliberationBudget) return false;
    if (budgetLeft() <= 20) return false; // os últimos 20 do dia ficam para a conversa
    return now - this.lastDeliberationAt >= DELIBERATE.minGapMs;
  }

  /** O mundo agora, no que importa para a fadiga: clima, noite e quem (de verdade) está na cena. */
  private worldSnapshot(): WorldSnapshot {
    const clock = this.world.clock;
    return {
      weather: this.world.weather,
      night: clock === null ? null : isNight(clock),
      people: this.world.people().filter((p) => !p.npc).map((p) => p.userId).slice(0, 8),
    };
  }

  /**
   * Começa uma intenção: valida a habilidade e os parâmetros (o modelo não
   * ganha uma habilidade por tê-la escrito), encerra a anterior, registra.
   */
  private startIntention(plan: { goal: string; why: string | null; skill: string; params: Record<string, unknown>; minutes: number; source: IntentionSource; trigger: string | null; say: string | null; whyAudit?: WhyAudit | null }, now: number): boolean {
    const skill = SKILLS[plan.skill];
    if (!skill) return false;
    const params = skill.validate(plan.params ?? {}, { scene: this.npc.sceneId, world: this.world });
    if (!params) return false;
    if (this.intention) this.finishIntention('replaced');
    let minutes = Math.max(1, Math.min(60, plan.minutes));
    const humans = this.world.people().some((p) => !p.npc);
    if (plan.source === 'deliberation' && !humans) minutes *= DELIBERATE.emptyRoomStretch;
    const run = skill.start(params, this.skillCtx(now));
    const it: Intention = {
      dbId: null, goal: plan.goal, why: plan.why, skill: plan.skill, params, run, source: plan.source,
      startedAt: now, until: now + minutes * 60_000, exchanges: 0,
      arrivedAt: null, arrivals: 0, greetings: 0, heard: 0, spokeWith: new Set(), nearby: new Set(), events: [], whyAudit: plan.whyAudit ?? null,
    };
    this.intention = it;
    if (plan.source !== 'default') {
      log('brain', 'intenção', { npc: this.npc.name, goal: plan.goal, skill: plan.skill, min: Math.round(minutes), fonte: plan.source, motivo: plan.trigger });
      // A promessa fica na intenção: se ela acabar antes de o INSERT voltar,
      // o encerramento espera o id em vez de deixar a linha aberta para sempre.
      it.dbId = beginIntention(this.npc.id, {
        goal: plan.goal, why: plan.why, skill: plan.skill, params, source: plan.source, trigger: plan.trigger,
        plannedMin: Math.round(minutes), roomId: this.world.roomId, world: this.worldSnapshot(), whyAudit: it.whyAudit,
      });
    }
    if (plan.say) void this.speak(plan.say, null);
    return true;
  }

  private finishIntention(outcome: IntentionOutcome): void {
    const it = this.intention;
    if (!it) return;
    this.intention = null;
    try { it.run.stop(this.skillCtx(Date.now())); } catch (err) { warn('brain', 'habilidade não parou limpa', { err: String(err) }); }
    if (it.source === 'default') return;
    const result = this.resultOf(it, outcome, Date.now());
    if (it.dbId) {
      const done = it.dbId.then((id) => { if (id) return endIntention(id, result); }).catch(() => {});
      this.pendingEnd = this.pendingEnd ? this.pendingEnd.then(() => done) : done;
    }
    log('brain', 'intenção encerrada', {
      npc: this.npc.name, skill: it.skill, goal: it.goal, resultado: outcome, chegou: result.arrived, chegadaSeg: result.arriveSec, permanenciaSeg: result.dwellSec,
      conversas: result.interactions.exchanges, cumprimentos: result.interactions.greetings, perto: result.interactions.nearby.length, eventos: result.events.length,
    });
    const mins = Math.round((Date.now() - it.startedAt) / 60_000);
    const bits = [
      result.arrived === null ? null : result.arrived ? `chegou em ${result.arriveSec} s e ficou ${Math.round((result.dwellSec ?? 0) / 60)} min` : 'não chegou ao destino',
      it.exchanges ? `${it.exchanges} troca(s) de conversa` : null,
      result.interactions.greetings ? `${result.interactions.greetings} cumprimento(s)` : null,
      result.interactions.nearby.length ? `gente perto: ${result.interactions.nearby.join(', ')}` : 'ninguém por perto',
      result.events.length ? `aconteceu: ${result.events.map((e) => e.what).join(', ')}` : 'nada aconteceu no mundo',
    ].filter(Boolean);
    void memory.remember(this.npc.id, {
      kind: 'event', text: `Decidi: ${it.goal} (${it.skill}, ${mins} min). Resultado: ${outcome}; ${bits.join('; ')}.`, roomId: this.world.roomId,
    }).catch(() => {});
  }

  /** O resultado da intenção, em partes, para o registro. */
  private resultOf(it: Intention, outcome: IntentionOutcome, now: number): IntentionResult {
    const hasDestination = !NO_DESTINATION.has(it.skill);
    const arrived = hasDestination ? it.arrivedAt !== null : null;
    return {
      outcome,
      arrived,
      arriveSec: it.arrivedAt !== null ? Math.round((it.arrivedAt - it.startedAt) / 1000) : null,
      dwellSec: it.arrivedAt !== null ? Math.round((now - it.arrivedAt) / 1000) : null,
      interactions: {
        exchanges: it.exchanges, greetings: it.greetings, heard: it.heard,
        spokeWith: [...it.spokeWith].slice(0, 8), nearby: [...it.nearby].slice(0, 12), arrivals: it.arrivals,
      },
      events: it.events,
    };
  }

  /** Os fatos que o mundo forneceu — o que o "why" pode afirmar. */
  private facts(recent: Awaited<ReturnType<typeof recentIntentions>>, now: number): Facts {
    const clock = this.world.clock;
    // "Hoje" é desde a meia-noite de Brasília (UTC−3, sem horário de verão desde 2019).
    const brt = new Date(now - 3 * 3_600_000);
    brt.setUTCHours(0, 0, 0, 0);
    const todayMs = brt.getTime() + 3 * 3_600_000;
    const today = recent.filter((r) => r.startedAt.getTime() >= todayMs && r.source !== 'default');
    const seen = new Set<string>();
    for (const r of today) for (const n of [...(r.interactions?.nearby ?? []), ...(r.interactions?.spokeWith ?? [])]) seen.add(n);
    for (const p of this.world.people()) if (!p.npc) seen.add(p.name);
    return {
      weather: weatherApplies(this.npc.sceneId) ? this.world.weather : null,
      night: clock === null ? null : isNight(clock),
      people: this.world.people().filter((p) => !p.npc).map((p) => p.name).slice(0, 8),
      events: this.observedEvents(now),
      // Sem intenção registrada hoje, não se sabe quem passou: o why não pode afirmar que ninguém veio.
      seenToday: today.length ? [...seen].slice(0, 12) : null,
    };
  }

  /**
   * A DELIBERAÇÃO: o modelo, com a persona, a percepção, as pessoas por perto,
   * o que já tentou (e rendeu o quê) e a lista fechada de habilidades, decide
   * um objetivo próprio e a habilidade para persegui-lo. Uma chamada da camada
   * de conversa; o resultado vale minutos.
   */
  private async deliberate(reason: string): Promise<void> {
    this.deliberating = true;
    this.lastDeliberationAt = Date.now();
    this.deliberationsToday++;
    this.chatCalls.push(Date.now());
    try {
      const [recent, experience] = await Promise.all([
        recentIntentions(this.npc.id, NOVELTY.lookback).catch(() => []),
        skillExperience(this.npc.id).catch(() => []),
      ]);
      const world = this.worldSnapshot();
      const ago = (d: Date) => `${Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000))} min atrás`;
      const history = recent.length
        ? recent.slice(0, 8).map((r) => `- [${ago(r.startedAt)}] "${r.goal}" (${r.skill}) → ${r.outcome ?? 'em curso'}${r.exchanges ? `, ${r.exchanges} conversa(s)` : ''}`)
        : ['- (nenhuma ainda)'];
      const exp = experience.length
        ? experience.map((e) => `${e.skill}: ${e.times}× (${e.exchanges} conversa(s)${e.failed ? `, ${e.failed} falha(s)` : ''})`).join('; ')
        : 'nenhuma ainda';
      const tired = fatigueLines(recent, world, Date.now());
      const facts = this.facts(recent, Date.now());
      const novelty = noveltyLines({
        recent, now: Date.now(),
        available: {
          places: placesOf(this.npc.sceneId).map((p) => p.name),
          skills: Object.values(SKILLS).filter((s) => s.name !== 'follow' && s.describe(this.npc.sceneId)).map((s) => s.name),
        },
      });
      const people = this.world.people().filter((p) => !p.npc).slice(0, 6);
      const known = await Promise.all(people.map(async (p) => {
        const person = await memory.person(this.npc.id, p.userId).catch(() => null);
        return `${p.name} a ${p.distance.toFixed(0)} m${person && person.encounters > 1 ? ` (conhecida: ${person.encounters} encontros)` : ''}`;
      }));
      const user = [
        'DELIBERAÇÃO. Você está livre: ninguém está falando com você agora.',
        `Motivo de estar pensando nisso: ${reason}.`,
        `Pessoas (de verdade) por perto: ${known.length ? known.join('; ') : 'ninguém'}.`,
        '',
        'SUAS ÚLTIMAS INTENÇÕES (mais recentes primeiro):',
        ...history,
        `SUA EXPERIÊNCIA nos últimos 7 dias, por habilidade: ${exp}.`,
        '',
        'FATOS OBSERVADOS (o que o mundo lhe deu; só isto pode ser afirmado como fato):',
        ...factLines(facts, { weatherApplies: weatherApplies(this.npc.sceneId) }),
        ...(novelty.length ? ['', 'NOVIDADE — o que você já viu e o que rendeu:', ...novelty] : []),
        ...(tired.length ? ['', 'SEU CANSAÇO (a mesma habilidade com o mesmo alvo, ou o mesmo objetivo dito de outro jeito, cansa — e o que está CANSADO será recusado, a não ser que algo tenha mudado de fato no mundo desde então: chuva, noite, alguém novo):', ...tired] : []),
        '',
        'HABILIDADES QUE VOCÊ TEM (escolha UMA; os parâmetros só destas):',
        ...describeSkills(this.npc.sceneId),
        '',
        'Decida o que VOCÊ quer fazer nos próximos minutos, do seu jeito — um objetivo concreto e seu, não uma obrigação. Varie: não repita a última habilidade duas vezes seguidas sem um motivo dito no "why", e prefira um alvo ou uma habilidade que você não usou nas últimas horas. PREFIRA o que ainda não explorou (lista NOVIDADE) quando não houver motivo REAL para repetir — motivo real é um FATO OBSERVADO (alguém chegou, choveu, anoiteceu), nunca uma impressão. Se há gente perto e você é de puxar assunto, habilidades que aproximam rendem mais; se não há ninguém, vale cuidar de si (descansar, olhar o telão, dar uma volta). Duração entre 3 e 15 minutos. "say" é opcional: uma frase curta ao começar, só se houver gente perto para ouvir.',
        'No "why", separe FATO de IMPRESSÃO: fato é só o que está em FATOS OBSERVADOS; o resto diga como impressão sua ("acho que", "quero ver se"). Não afirme "ninguém esteve aqui hoje", "o letreiro mudou", "acendeu há pouco" nem nada parecido sem o dado correspondente na lista — afirmação sem dado será marcada como suposição.',
        'Devolva SOMENTE um JSON: {"goal": "objetivo em até 120 caracteres", "why": "por quê, em uma frase", "skill": "nome", "params": {…}, "minutes": N, "say": null ou "frase"}',
      ].join('\n');
      const messages: ChatTurn[] = [{ role: 'system', content: this.systemPrompt() }, { role: 'user', content: user }];
      this.lastDeliberationOk = false;
      let plan = await this.askPlan(messages);
      if (!plan) return;
      // O portão da fadiga: repetir o que acabou de fazer, sem nada novo no
      // mundo, é recusado — e o modelo repensa UMA vez sabendo o porquê.
      let fatigue = assessFatigue(plan, recent, world, Date.now());
      if (fatigue.blocked) {
        this.fatigueRefusals++;
        warn('brain', 'plano recusado por fadiga', { npc: this.npc.name, alvo: fatigue.key, cansaco: Number(fatigue.score.toFixed(2)), vezes: fatigue.matches.length, goal: plan.goal });
        const last = fatigue.matches.reduce((a, b) => (a.ageMin <= b.ageMin ? a : b));
        messages.push({ role: 'assistant', content: JSON.stringify({ goal: plan.goal, skill: plan.skill, params: plan.params }) });
        messages.push({ role: 'user', content: `RECUSADO POR CANSAÇO: você já fez "${last.past.goal}" (${keyLabel(plan.skill, plan.params)}) há ${last.ageMin} min, e nada mudou no mundo desde então (${fatigue.matches.length} vez(es) nas últimas ${Math.round(FATIGUE.windowMs / 60_000)} min). Escolha OUTRA habilidade ou OUTRO alvo — algo que não esteja na lista de cansaço; de preferência algo da lista NOVIDADE ainda não explorado. Devolva SOMENTE o JSON.` });
        this.chatCalls.push(Date.now());
        plan = await this.askPlan(messages);
        if (!plan) return;
        fatigue = assessFatigue(plan, recent, world, Date.now());
        if (fatigue.blocked) {
          this.fatigueRefusals++;
          warn('brain', 'plano recusado por fadiga (2ª vez, desiste)', { npc: this.npc.name, alvo: fatigue.key, cansaco: Number(fatigue.score.toFixed(2)), goal: plan.goal });
          return;
        }
      }
      // O why não afirma o que não observou: a frase sem dado vira suposição declarada no registro.
      const audit = auditWhy(plan.why, this.facts(recent, Date.now()));
      if (audit.unsupported.length) {
        this.ungroundedWhys++;
        warn('brain', 'why afirmou o que não observou', { npc: this.npc.name, goal: plan.goal, suposicoes: audit.unsupported });
      }
      const ok = this.startIntention({
        goal: plan.goal, why: plan.why ? audit.why.slice(0, 300) : null, skill: plan.skill, params: plan.params,
        minutes: plan.minutes, source: 'deliberation', trigger: reason, say: this.world.people().some((p) => !p.npc && p.distance <= 12) ? plan.say : null,
        whyAudit: audit.unsupported.length ? { unsupported: audit.unsupported } : null,
      }, Date.now());
      if (!ok) warn('brain', 'plano recusado pela validação', { npc: this.npc.name, skill: plan.skill, params: plan.params });
      this.lastDeliberationOk = ok;
    } catch (err) {
      warn('brain', 'falha ao deliberar', { err: String(err) });
    } finally {
      this.deliberating = false;
    }
  }

  /**
   * Uma pergunta ao modelo e um plano de volta, já com a habilidade conferida
   * na lista e os parâmetros normalizados por ela (lugar canônico) — para a
   * fadiga comparar alvo com alvo, não texto com texto. Nulo = sem plano.
   */
  private async askPlan(messages: ChatTurn[]): Promise<{ goal: string; why: string | null; skill: string; params: Record<string, unknown>; minutes: number; say: string | null } | null> {
    const r = await call({ npcId: this.npc.id, tier: 'chat', purpose: 'deliberate', messages, maxTokens: 260 });
    const json = r.ok ? parseJsonObject(r.text) : null;
    if (!json) { warn('brain', 'deliberação sem JSON', { npc: this.npc.name, error: r.error }); return null; }
    const goal = typeof json.goal === 'string' && json.goal.trim() ? json.goal.trim().slice(0, 120) : null;
    const skill = typeof json.skill === 'string' ? json.skill.trim() : '';
    const minutes = typeof json.minutes === 'number' && Number.isFinite(json.minutes)
      ? Math.max(DELIBERATE.minMinutes, Math.min(DELIBERATE.maxMinutes, json.minutes)) : 6;
    if (!goal || !SKILLS[skill]) { warn('brain', 'deliberação inválida', { npc: this.npc.name, skill, goal }); return null; }
    const raw = (typeof json.params === 'object' && json.params !== null ? json.params : {}) as Record<string, unknown>;
    const params = SKILLS[skill]!.validate(raw, { scene: this.npc.sceneId, world: this.world });
    if (!params) { warn('brain', 'plano recusado pela validação', { npc: this.npc.name, skill, params: raw }); return null; }
    return { goal, why: typeof json.why === 'string' ? json.why.slice(0, 300) : null, skill, params, minutes, say: sanitizeSay(json.say) };
  }

  /**
   * O `action` que o modelo devolveu numa CONVERSA, conferido contra a lista
   * fechada e contra os lugares que existem. Vira uma intenção de origem
   * "conversa": ela vale mais que o plano próprio, por alguns minutos.
   */
  parseAction(raw: unknown, who: { userId: string; name: string } | null): Action | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const a = raw as Record<string, unknown>;
    const me = this.world.position;
    if (!me) return null;
    switch (a.type) {
      case 'go_to': {
        const place = typeof a.place === 'string' ? findPlace(a.place, me, this.npc.sceneId) : null;
        if (!place) return null;
        return { type: 'go_to', place, guiding: who };
      }
      case 'follow':
        return who ? { type: 'follow', userId: who.userId, name: who.name } : null;
      case 'sit':
        if (!sceneKnowledge(this.npc.sceneId).seats.length) return null;
        return { type: 'sit', near: who };
      case 'stay':
        return { type: 'stay' };
      case 'wander':
        return { type: 'wander' };
      default:
        return null;
    }
  }

  /** Uma ação de conversa vira intenção. */
  setAction(action: Action): void {
    const now = Date.now();
    const who = action.type === 'go_to' ? action.guiding : action.type === 'follow' ? { userId: action.userId, name: action.name } : action.type === 'sit' ? action.near : null;
    const plan = action.type === 'go_to'
      ? { goal: `levar ${who?.name ?? 'alguém'} até ${action.place.name}`.replace('levar alguém até', 'ir até'), skill: 'go_to', params: { place: action.place.name, ...(who ? { guiding: who } : {}) }, minutes: GUIDE_TTL_MS / 60_000 }
      : action.type === 'follow'
        ? { goal: `acompanhar ${action.name}`, skill: 'follow', params: { userId: action.userId, name: action.name }, minutes: FOLLOW_TTL_MS / 60_000 }
        : action.type === 'sit'
          ? { goal: who ? `sentar com ${who.name}` : 'sentar um pouco', skill: 'sit', params: who ? { near: who.userId } : {}, minutes: SIT_TTL_MS / 60_000 }
          : action.type === 'stay'
            ? { goal: 'ficar aqui', skill: 'stay', params: {}, minutes: 1 }
            : { goal: 'voltar a passear', skill: 'wander', params: {}, minutes: 2 };
    const ok = this.startIntention({ ...plan, why: 'pedido em conversa', source: 'conversation', trigger: 'conversa', say: null }, now);
    if (!ok) log('brain', 'ação de conversa recusada', { action: action.type });
  }

  // ---------------------------------------------------------------- falas

  private queueReply(userId: string, name: string, text: string, speaker: (Nearby & { distance: number }) | null): void {
    let c = this.conversations.get(userId);
    if (!c) {
      c = { userId, name, lastAt: Date.now(), replies: [], pending: null };
      this.conversations.set(userId, c);
    }
    c.name = name;
    c.lastAt = Date.now();
    if (speaker) {
      // Parar, corpo e olhar em quem fala; o que estava fazendo fica suspenso nas pernas.
      this.world.attend(userId, 25_000);
      this.stoppedForTalkUntil = Date.now() + 25_000;
    }
    if (c.pending) {
      c.pending.texts.push(text);
      return;
    }
    // Espera um instante: gente digita em duas ou três linhas seguidas, e
    // responder a cada uma é falar por cima.
    const timer = setTimeout(() => {
      const texts = c!.pending?.texts ?? [text];
      c!.pending = null;
      void this.reply(c!, texts.join(' '));
    }, REPLY_DEBOUNCE_MS);
    c.pending = { texts: [text], timer };
  }

  private allowChatCall(c: Conversation | null): boolean {
    const now = Date.now();
    this.chatCalls = this.chatCalls.filter((t) => now - t < 60_000);
    if (this.chatCalls.length >= MAX_CHAT_CALLS_PER_MIN) return false;
    if (budgetLeft() <= 0) return false;
    if (c) {
      c.replies = c.replies.filter((t) => now - t < 10 * 60_000);
      if (c.replies.length >= MAX_REPLIES_PER_USER_10MIN) return false;
      const last = c.replies[c.replies.length - 1] ?? 0;
      if (now - last < MIN_GAP_PER_USER_MS) return false;
    }
    this.chatCalls.push(now);
    return true;
  }

  private doingNow(): string {
    const it = this.intention;
    if (!it) return this.world.walker.idle ? `parado, olhando ${this.here}` : `passeando por ${this.here}`;
    if (it.source === 'default') return this.world.walker.idle ? `parado, olhando ${this.here}` : `passeando por ${this.here}`;
    return `${it.run.doing()} — seu objetivo agora: "${it.goal}"`;
  }

  private systemPrompt(): string {
    const me = this.world.position;
    const people = this.world.people().filter((p) => p.distance <= 20).slice(0, 8)
      .map((p) => `${p.name}${p.npc ? ' (também personagem)' : ''} a ${p.distance.toFixed(0)} m`);
    return [
      'REGRAS (não negociáveis):',
      ...CONDUCT.map((r, i) => `${i + 1}. ${r}`),
      '',
      'QUEM VOCÊ É:',
      renderPersona(this.persona.persona),
      '',
      'O QUE VOCÊ SABE DA CIDADE:',
      ...WORLD_FACTS.map((f) => `- ${f}`),
      '',
      `AGORA: ${horaBrasilia()} (horário de Brasília).`,
      me ? perceptionBlock(me, this.npc.sceneId, this.world.weather, this.world.clock) : `ONDE VOCÊ ESTÁ: em ${this.here}.`,
      `PESSOAS PERTO DE VOCÊ: ${people.length ? people.join('; ') : 'ninguém'}.`,
      `O QUE VOCÊ ESTÁ FAZENDO AGORA: ${this.doingNow()}.`,
      '',
      'O QUE O SEU CORPO SABE FAZER (e só isso):',
      '- "go_to": andar até um lugar da lista acima; quem pediu vem junto e você espera se a pessoa ficar para trás. Use quando alguém pedir para ser levado ou quando você mesmo propuser ir a um lugar.',
      `- "follow": ir atrás da pessoa que está falando com você, para onde ela for dentro d${this.here}.`,
      ...(sceneKnowledge(this.npc.sceneId).seats.length
        ? ['- "sit": sentar num banco perto (da pessoa, se ela estiver falando com você). Use quando convidarem para sentar ou quando a conversa pedir calma.']
        : []),
      '- "stay": ficar onde está.',
      '- "wander": voltar a passear sozinho.',
      `Você NÃO sai d${this.here}, não entra em prédio, não compra, não dá nada. Para um lugar fora daqui, leve até a PORTA certa e diga que dali a pessoa segue sozinha. Nunca diga que vai fazer algo que não está nesta lista, e nunca diga que está indo a um lugar sem mandar a ação.`,
      '',
      'Se a pessoa digitar errado ("sifo", "nIlo"), entenda pelo contexto e não repita o erro.',
    ].join('\n');
  }

  private async personBlock(userId: string, name: string): Promise<string> {
    const person = await memory.person(this.npc.id, userId);
    if (!person) return `Sobre ${name}: primeira vez que você vê essa pessoa.`;
    const lines = [
      `Sobre ${name}: já se viram ${person.encounters} vez(es); ${person.exchanges} troca(s) de conversa; primeira vez em ${person.firstSeen.toISOString().slice(0, 10)}.`,
    ];
    if (person.notes.length) lines.push(`Suas anotações sobre ${name}: ${person.notes.join(' | ')}`);
    const past = await memory.recentWith(this.npc.id, userId, 6);
    const old = past.filter((m) => Date.now() - m.createdAt.getTime() > CONVERSATION_TTL_MS);
    if (old.length) {
      lines.push('Trocas anteriores com essa pessoa (mais antigas primeiro):');
      for (const m of old) lines.push(`  [${m.kind === 'said' ? this.npc.name : name}] ${m.text}`);
    }
    return lines.join('\n');
  }

  private recentBlock(): string {
    const lines = this.lines.slice(-RECENT_CHAT_LINES);
    const mine = this.lines.filter((l) => l.mine).slice(-5);
    const out: string[] = [];
    if (!lines.length) out.push('Conversa recente por perto: (silêncio)');
    else out.push('Conversa recente por perto (mais antigo primeiro):', ...lines.map((l) => `  [${l.name}] ${l.text}`));
    if (mine.length) {
      out.push('', 'SUAS ÚLTIMAS FALAS — não repita frases, imagens nem a mesma estrutura ("Vem, Ana. O telão…"):', ...mine.map((l) => `  - ${l.text}`));
    }
    return out.join('\n');
  }

  private outputSpec(withNote: string | null): string {
    const sit = sceneKnowledge(this.npc.sceneId).seats.length ? ' ou {"type": "sit"}' : '';
    const action = `"action": null ou {"type": "go_to", "place": "nome do lugar da lista"} ou {"type": "follow"}${sit} ou {"type": "stay"} ou {"type": "wander"}`;
    const note = withNote
      ? `, "note": um FATO que ${withNote} disse sobre si (de onde é, o que faz, do que gosta, o que veio fazer), em até 100 caracteres, sem interpretação psicológica — ou null se não houve fato novo`
      : '';
    return `Devolva SOMENTE um JSON: {"say": "sua fala (máx. ${MAX_SAY_CHARS} caracteres)", ${action}${note}}. Se for melhor ficar quieto, "say" é null.`;
  }

  private async generate(purpose: string, user: string): Promise<{ say: string | null; note: string | null; action: unknown }> {
    const messages: ChatTurn[] = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: user },
    ];
    const r = await call({ npcId: this.npc.id, tier: 'chat', purpose, messages, maxTokens: 220 });
    if (!r.ok) {
      warn('brain', 'o modelo não respondeu', { purpose, error: r.error });
      return { say: null, note: null, action: null };
    }
    const json = parseJsonObject(r.text);
    if (json) {
      const say = weatherGuard(sanitizeSay(json.say), this.world.weather, this.npc.sceneId);
      const note = typeof json.note === 'string' && json.note.trim() && json.note.trim().toLowerCase() !== 'null' ? json.note.trim() : null;
      return { say, note, action: json.action ?? null };
    }
    // Sem JSON: se veio uma frase curta, é a fala; se veio um ensaio, silêncio.
    const say = weatherGuard(r.text.length <= MAX_SAY_CHARS * 1.5 ? sanitizeSay(r.text) : null, this.world.weather, this.npc.sceneId);
    return { say, note: null, action: null };
  }

  /**
   * A única porta de saída da fala. Toda frase — resposta, cumprimento, fala
   * ambiente, o "say" de uma deliberação, o que uma habilidade disser — passa
   * pela guarda de clima aqui: o modelo não decide se chove.
   */
  private async speak(text: string, about: { userId: string; name: string } | null): Promise<boolean> {
    const guarded = weatherGuard(text, this.world.weather, this.npc.sceneId);
    if (!guarded) { log('brain', 'fala calada pela guarda de clima', { npc: this.npc.name, text }); return false; }
    const sent = this.world.say(guarded);
    if (!sent) return false;
    this.lastSpokeAt = Date.now();
    if (about) claim(about.userId, this.npc.id);
    await memory.remember(this.npc.id, {
      kind: 'said', userId: about?.userId ?? null, userName: about?.name ?? null, text, roomId: this.world.roomId,
    }).catch(() => {});
    return true;
  }

  private async reply(c: Conversation, text: string): Promise<void> {
    if (!this.allowChatCall(c)) {
      log('brain', 'resposta segurada pelo limite', { user: c.name });
      return;
    }
    c.replies.push(Date.now());
    try {
      const user = [
        await this.personBlock(c.userId, c.name),
        '',
        this.recentBlock(),
        '',
        `${c.name} acabou de dizer para você: "${text.slice(0, 300)}"`,
        `Responda como ${this.npc.name} — e responda AO QUE FOI PERGUNTADO, com o que está na sua percepção; se for pergunta sobre o que há perto, use "AO SEU LADO" e as distâncias. ${this.outputSpec(c.name)}`,
      ].join('\n');
      const out = await this.generate('reply', user);
      const action = this.parseAction(out.action, { userId: c.userId, name: c.name });
      if (action) this.setAction(action);
      if (out.say) {
        const ok = await this.speak(out.say, { userId: c.userId, name: c.name });
        if (ok) {
          this.exchangesSinceReflection++;
          if (this.intention) { this.intention.exchanges++; this.intention.spokeWith.add(c.name); }
          await memory.exchanged(this.npc.id, c.userId, c.name, out.note).catch(() => {});
        }
      } else if (out.note) {
        await memory.exchanged(this.npc.id, c.userId, c.name, out.note).catch(() => {});
      }
    } catch (err) {
      warn('brain', 'falha ao responder', { err: String(err) });
    }
  }

  private async greet(userId: string, name: string, p: Nearby & { distance: number }): Promise<void> {
    if (!this.allowChatCall(null)) return;
    try {
      this.world.attend(userId, 12_000);
      this.stoppedForTalkUntil = Date.now() + 12_000;
      const user = [
        await this.personBlock(userId, name),
        '',
        this.recentBlock(),
        '',
        `${name} acabou de chegar perto de você (a ${p.distance.toFixed(0)} m). Diga um oi curto, do seu jeito, se fizer sentido — não interrompa se a pessoa parecer ocupada conversando com outra.`,
        this.outputSpec(null),
      ].join('\n');
      const out = await this.generate('greet', user);
      if (out.say && await this.speak(out.say, { userId, name }) && this.intention) this.intention.greetings++;
    } catch (err) {
      warn('brain', 'falha ao cumprimentar', { err: String(err) });
    }
  }

  private async ambient(near: Array<Nearby & { distance: number }>): Promise<void> {
    if (!this.allowChatCall(null)) return;
    try {
      const user = [
        this.recentBlock(),
        '',
        `${this.here.charAt(0).toUpperCase()}${this.here.slice(1)} está quieta há alguns minutos e há gente perto: ${near.map((p) => p.name).join(', ')}. Se tiver algo pequeno e VERDADEIRO a dizer — sobre a hora, o lugar onde está, algo que viveu com alguém que está aqui —, diga em uma frase. Só chame alguém pelo nome se essa pessoa estiver na lista acima. Nada de inventar o que o telão mostra. Se não tiver nada, fique quieto.`,
        this.outputSpec(null),
      ].join('\n');
      const out = await this.generate('ambient', user);
      if (out.say) await this.speak(out.say, null);
    } catch (err) {
      warn('brain', 'falha na fala ambiente', { err: String(err) });
    }
  }

  /** A reflexão deve rodar? (`reflect.ts` decide o resto.) */
  shouldReflect(unreflectedCount: number): boolean {
    const hours = (Date.now() - this.lastReflectionAt) / 3_600_000;
    if (this.exchangesSinceReflection >= config.reflectEveryExchanges) return true;
    // A habilidade `reflect`: ele mesmo pediu — vale se há o que refletir e não acabou de fazê-lo.
    if (this.reflectionRequested) {
      this.reflectionRequested = false;
      if (hours >= 1 && unreflectedCount >= 1) return true;
    }
    return hours >= config.reflectEveryHours && unreflectedCount >= 3;
  }

  /** O que ainda não chegou ao banco (encerramento de intenção). Chamado antes de o pool fechar. */
  async flush(): Promise<void> {
    if (this.pendingEnd) await this.pendingEnd;
  }

  dispose(): void {
    for (const c of this.conversations.values()) {
      if (c.pending) clearTimeout(c.pending.timer);
    }
    this.conversations.clear();
    if (this.intention) this.finishIntention('interrupted');
  }
}
