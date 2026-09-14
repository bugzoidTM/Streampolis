import { isAddressed } from './brain.js';
import { GATHER, GATHERINGS, type Gathering } from './gatherings.js';
import { log } from './log.js';
import { mulberry32, seedOf, type Mind } from './mind.js';
import type { AmbientProfile, AmbientStep } from './roster.js';
import { ahead, clearanceFor, coveredPoints, isCovered, nearestFree, sceneKnowledge, weatherApplies } from './scenes.js';
import { freeSeatNear } from './seats.js';
import type { AnimState, ChatMessage } from './shared.js';
import type { Point } from './walker.js';
import type { Nearby, World } from './world.js';

/**
 * Figurante com corpo de verdade: máquina de estados sobre um programa.
 *
 * Nada aqui é vontade. O programa diz "fique aqui 40–90 s, depois ande até
 * ali, depois sente", e a mente só cumpre e recomeça. O que faz um figurante
 * destes valer mais que os desenhados no cliente (`AmbientCrowd`) é que ele é
 * o MESMO para todo mundo, colide, tem nome na placa e se vira para quem o
 * chama — e o servidor sabe que ele existe.
 *
 * A única fala é de balcão: se o perfil traz `lines` e alguém o chama pelo
 * nome a até 6 m, ele diz uma delas (com intervalo longo). Sem `lines`, só se
 * vira para a pessoa por alguns segundos. Nada de conversa: figurante que
 * conversa é um personagem social, e essa é outra classe.
 *
 * Vida social sem fala, entre eles (2026-09-14):
 *
 *   - **encontro**: dois figurantes COMPATÍVEIS (uma partição fixa por id —
 *     não há personalidade aqui) que se cruzam a menos de 3 m param, viram
 *     um para o outro e um gesto sai de cada lado (acenar, bater palma).
 *     Dez segundos e cada um segue. Um par não repete em dez minutos;
 *   - **rodinha** (`gatherings.ts`): quem passeia (programa com passo de
 *     andar) pode entrar numa rodinha de 2–3 num ponto social da cena, ou
 *     abrir uma; fica virado para o centro, gesticula de vez em quando, e
 *     dispersa em poucos minutos. Quem tem posto fixo (porteiro, DJ,
 *     recepcionista) não sai do posto.
 *
 * Nenhum dos dois usa chat nem modelo de linguagem, e nenhum toca no
 * servidor: é tudo intenção de movimento e gesto, como sempre.
 *
 * **Chuva** (estado da sala, `World.weather`; só onde o clima é desenhado —
 * a praça): quem passeia escolhe destinos cobertos (copas, toldos dos
 * quiosques, marquises das portas), demora pouco em posto aberto e muito em
 * posto coberto, quase não senta em banco descoberto, e a rodinha só se forma
 * debaixo de algo. Alguns continuam andando — é chuva, não tempestade.
 */
const RAIN = {
  /** Fração das caminhadas livres que vão para um ponto coberto. */
  coveredWalks: 0.75,
  /** Permanência em posto/parada ABERTA, em relação ao normal. */
  openDwell: 0.3,
  /** Permanência em ponto COBERTO, em relação ao normal. */
  coveredDwell: 1.6,
  /** Chance de pular um passo de sentar (banco descoberto). */
  skipSit: 0.7,
} as const;

const CALL_M = 6;
const LINE_GAP_MS = 60_000;
const LINE_PER_PERSON_MS = 180_000;
const TURN_MS = 5_000;

export const ENCOUNTER = {
  nearM: 3.2,
  minMs: 7_000,
  maxMs: 13_000,
  pairCooldownMs: 10 * 60_000,
  selfCooldownMs: 3 * 60_000,
  /** Chance por tique (2 s) de um par elegível e próximo parar de fato. */
  chance: 0.35,
} as const;

/** Chance por tique (2 s) de um figurante que passeia procurar/abrir uma rodinha. */
const GATHER_CHANCE = 0.012;
const GATHER_REACH_M = 25;
const GESTURES: AnimState[] = ['wave', 'clap'];

/** Os figurantes deste processo, para um encontro ter os dois lados. */
export const AMBIENT_PEERS = new Map<string, AmbientMind>();

/**
 * Compatibilidade entre dois figurantes: partição fixa e simétrica dos ids
 * (~40 % dos pares). Sem personalidade nesta classe, é só o que basta para
 * nem todo mundo cumprimentar todo mundo.
 */
export function compatible(a: string, b: string): boolean {
  return ((seedOf(a) ^ seedOf(b)) >>> 0) % 5 < 2;
}

type Phase = 'going' | 'doing';

interface InGathering { g: Gathering; slot: Point; until: number; arrived: boolean; nextGestureAt: number }

export class AmbientMind implements Mind {
  private readonly rng: () => number;
  private step = -1;
  private phase: Phase = 'going';
  private doneAt = 0;
  private lastLineAt = 0;
  private lineIndex = 0;
  private readonly lineAt = new Map<string, number>();
  private stuckSteps = 0;
  /** Prazo para CHEGAR ao que o passo pede; vencido, o programa segue. */
  private goingUntil = 0;
  /** Encontro em curso: até quando, e com quem. */
  private encounterUntil = 0;
  private lastEncounterAt = 0;
  private readonly encounteredAt = new Map<string, number>();
  private gathering: InGathering | null = null;
  private gatherCooldownUntil = 0;
  /** `stuckCount` das pernas quando o passo começou: se não subiu, parar é ter chegado. */
  private stuckMark = 0;
  private timers: NodeJS.Timeout[] = [];
  private readonly roams: boolean;

  constructor(
    readonly npc: { id: string; name: string; sceneId: World['sceneId'] },
    private world: World,
    private readonly profile: AmbientProfile,
  ) {
    this.rng = mulberry32(seedOf(npc.id));
    this.roams = profile.program.some((s) => s.do === 'walk');
    AMBIENT_PEERS.set(npc.id, this);
  }

  get roomId(): string | null {
    return this.world.roomId;
  }

  rebind(world: World): void {
    this.world = world;
    this.step = -1;
    this.phase = 'going';
    this.doneAt = 0;
    this.leaveGathering(false);
    this.encounterUntil = 0;
  }

  status(): Record<string, unknown> {
    const s = this.current();
    return {
      role: this.profile.role, step: this.step, phase: this.phase, doing: s?.do ?? null, pose: this.world.pose,
      encounter: this.encounterUntil > Date.now(), gathering: this.gathering ? this.gathering.g.id : null, rain: this.raining(),
    };
  }

  private current(): AmbientStep | null {
    return this.profile.program[this.step] ?? null;
  }

  /** Está chovendo AQUI (a sala diz que chove e esta cena sente o clima)? */
  private raining(): boolean {
    return this.world.weather === 'rain' && weatherApplies(this.npc.sceneId);
  }

  /** Fator de permanência de um ponto, pela chuva e pela cobertura. */
  private dwellFactor(at: Point): number {
    if (!this.raining()) return 1;
    return isCovered(this.npc.sceneId, at) ? RAIN.coveredDwell : RAIN.openDwell;
  }

  private secs(range: [number, number] | undefined, fallback: [number, number] = [8, 20]): number {
    const [a, b] = range ?? fallback;
    return (a + this.rng() * Math.max(0, b - a)) * 1000;
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers = this.timers.filter((x) => x !== t); fn(); }, ms);
    t.unref?.();
    this.timers.push(t);
  }

  // ------------------------------------------------------------- programa

  tick(): void {
    const me = this.world.position;
    if (!me || !this.profile.program.length) return;
    const walker = this.world.walker;
    const now = Date.now();

    if (this.encounterUntil > now) return;
    if (walker.attending) return;

    if (this.gathering) { this.gatherTick(me, now); return; }

    this.maybeEncounter(me, now);
    if (this.encounterUntil > now) return;
    if (this.maybeGather(me, now)) return;

    const step = this.current();
    if (!step) { this.advance(me); return; }
    if (this.phase === 'going' && this.goingUntil && now > this.goingUntil) {
      log('ambient', 'não chegou a tempo; segue o programa', { npc: this.npc.name, step: this.step, do: step.do });
      this.advance(me);
      return;
    }

    if (step.do === 'stand') {
      const at = step.at;
      const d = Math.hypot(at.x - me.x, at.z - me.z);
      if (this.phase === 'going') {
        // Chegou — ou parou ao lado porque alguém está em cima do posto (a
        // separação local desloca o destino em até 2,5 m).
        if (d <= 1.0 || (walker.idle && walker.staying && d <= 2.8 && walker.stuckCount === this.stuckMark)) {
          this.phase = 'doing';
          this.doneAt = now + this.secs(step.secs, [30, 90]) * this.dwellFactor(at);
          if (typeof step.yaw === 'number') this.world.faceTo(ahead(me, step.yaw));
          this.world.pose = step.pose && step.pose !== 'idle' ? step.pose : null;
          walker.hold = step.pose === 'sit' ? 'seated' : this.world.pose ? 'gesture' : 'free';
        } else if (walker.idle && !walker.staying) {
          walker.setTarget(at);
        } else if (walker.idle && d > 1.0) {
          this.stuck(me);
        }
        return;
      }
      if (now >= this.doneAt) this.advance(me);
      return;
    }

    if (step.do === 'walk') {
      if (this.phase === 'going') {
        if (walker.idle) {
          // A ordem de ir saiu em `advance`; parado agora é porque chegou (ou desistiu).
          const arrived = walker.stuckCount === this.stuckMark;
          if (arrived) {
            this.phase = 'doing';
            this.doneAt = now + this.secs(step.secs, [2, 8]) * this.dwellFactor(me);
          } else {
            this.stuck(me);
          }
        }
        return;
      }
      if (now >= this.doneAt) this.advance(me);
      return;
    }

    // sit
    if (this.phase === 'going') {
      if (this.doneAt === 0 && !walker.sitting && this.raining() && this.rng() < RAIN.skipSit) { this.advance(me); return; }
      if (walker.seated) {
        this.phase = 'doing';
        this.doneAt = now + this.secs(step.secs, [40, 120]);
        walker.hold = 'seated';
        return;
      }
      if (!walker.sitting) {
        if (this.doneAt === 0) {
          const seats = sceneKnowledge(this.npc.sceneId).seats;
          const near = step.near ?? me;
          const occupied = this.world.people().map((p) => ({ x: p.x, z: p.z }));
          const seat = freeSeatNear(seats, near, occupied);
          if (!seat) { this.advance(me); return; }
          walker.sitAt({ at: seat.at, yaw: seat.yaw });
          this.doneAt = 1;
        } else {
          this.stuck(me);
        }
      }
      return;
    }
    if (now >= this.doneAt) { walker.standUp(); this.advance(me); }
  }

  /** Um passo que não se completa não trava o programa: conta e segue. */
  private stuck(me: { x: number; z: number }): void {
    if (++this.stuckSteps > 60) log('ambient', 'passo abandonado', { npc: this.npc.name, step: this.step });
    else if (this.stuckSteps < 3) return;
    this.advance(me);
  }

  private advance(me: { x: number; z: number }): void {
    const walker = this.world.walker;
    walker.release();
    walker.hold = 'free';
    this.world.pose = null;
    this.stuckSteps = 0;
    this.phase = 'going';
    this.doneAt = 0;
    this.goingUntil = Date.now() + 120_000;
    this.stuckMark = walker.stuckCount;
    this.step = (this.step + 1) % this.profile.program.length;
    const step = this.current();
    if (!step) return;
    if (step.do === 'stand') {
      const at = nearestFree(this.npc.sceneId, step.at, clearanceFor(step.pose));
      step.at = at;
      // `stayAt` para tudo o que era ordem; a ordem de ir tem de vir depois dela.
      walker.stayAt(at);
      if (Math.hypot(at.x - me.x, at.z - me.z) > 1.0) walker.setTarget(at);
    } else if (step.do === 'walk') {
      if (step.to) {
        step.to = nearestFree(this.npc.sceneId, step.to);
        walker.setTarget(step.to);
      } else if (this.raining() && this.rng() < RAIN.coveredWalks && coveredPoints(this.npc.sceneId).length) {
        // Chovendo: para debaixo de alguma coisa (o mais das vezes).
        const covered = coveredPoints(this.npc.sceneId).filter((c) => !walker.occupied(c));
        const pool = covered.length ? covered : coveredPoints(this.npc.sceneId);
        walker.setTarget(pool[Math.floor(this.rng() * pool.length)]!);
      } else {
        walker.pickDestination(me, this.rng);
      }
    }
  }

  // ------------------------------------------------------------ encontros

  /** Livre para parar e cumprimentar alguém: nem sentado, nem em postura, nem numa rodinha. */
  eligibleForEncounter(now = Date.now()): boolean {
    const w = this.world.walker;
    if (!this.world.connected || this.gathering || this.encounterUntil > now || w.attending) return false;
    if (w.sitting || w.seated || w.hold !== 'free') return false;
    return now - this.lastEncounterAt >= ENCOUNTER.selfCooldownMs;
  }

  private maybeEncounter(me: Point, now: number): void {
    if (!this.eligibleForEncounter(now)) return;
    for (const p of this.world.people()) {
      if (!p.npc || p.distance > ENCOUNTER.nearM) continue;
      const peer = AMBIENT_PEERS.get(p.userId);
      if (!peer || peer.roomId !== this.roomId) continue;
      if (!compatible(this.npc.id, p.userId)) continue;
      if (now - (this.encounteredAt.get(p.userId) ?? 0) < ENCOUNTER.pairCooldownMs) continue;
      if (!peer.eligibleForEncounter(now)) continue;
      if (this.rng() > ENCOUNTER.chance) continue;
      const ms = ENCOUNTER.minMs + this.rng() * (ENCOUNTER.maxMs - ENCOUNTER.minMs);
      this.encounter(p.userId, ms, GESTURES[Math.floor(this.rng() * GESTURES.length)]!, 400);
      peer.encounter(this.npc.id, ms, GESTURES[Math.floor(this.rng() * GESTURES.length)]!, 2_000);
      log('ambient', 'encontro', { a: this.npc.name, b: p.name, s: Math.round(ms / 1000) });
      return;
    }
  }

  /** Parar, virar-se para `otherId` por `ms`, fazer um gesto depois de `delayMs`, e voltar ao neutro. */
  encounter(otherId: string, ms: number, gesture: AnimState, delayMs: number): void {
    const now = Date.now();
    this.encounterUntil = now + ms;
    this.lastEncounterAt = now;
    this.encounteredAt.set(otherId, now);
    this.world.attend(otherId, ms);
    this.later(delayMs, () => this.world.walker.emote(gesture));
    // O gesto na sala dura até o corpo andar; parado, ele voltaria a acenar para sempre.
    this.later(delayMs + 3_500, () => this.world.walker.emote(this.world.pose ?? 'idle'));
  }

  // ------------------------------------------------------------- rodinhas

  private maybeGather(me: Point, now: number): boolean {
    if (!this.roams || now < this.gatherCooldownUntil || !this.world.roomId) return false;
    if (this.rng() > GATHER_CHANCE) return false;
    const room = this.world.roomId;
    const rain = this.raining();
    let g = GATHERINGS.joinable(room, me, GATHER_REACH_M, now);
    if (g && rain && !isCovered(this.npc.sceneId, g.center)) g = null;
    if (!g && this.rng() < 0.5) g = GATHERINGS.open(this.npc.sceneId, room, me, GATHER_REACH_M, this.rng, now, rain ? (p) => isCovered(this.npc.sceneId, p) : null);
    if (!g) return false;
    return this.joinGathering(g, now);
  }

  /** Entra numa rodinha (também chamado por quem a abriu para convidar). */
  joinGathering(g: Gathering, now = Date.now()): boolean {
    const slot = GATHERINGS.join(g, this.npc.id);
    if (!slot) return false;
    const walker = this.world.walker;
    walker.release();
    walker.hold = 'free';
    this.world.pose = null;
    const until = Math.min(g.until, now + 90_000 + this.rng() * 150_000);
    this.gathering = { g, slot, until, arrived: false, nextGestureAt: 0 };
    walker.setTarget(slot);
    log('ambient', 'rodinha', { npc: this.npc.name, id: g.id, membros: g.members.size });
    return true;
  }

  private gatherTick(me: Point, now: number): void {
    const gg = this.gathering!;
    const walker = this.world.walker;
    if (now >= gg.until || !GATHERINGS.alive(gg.g, now)) { this.leaveGathering(true); return; }
    const d = Math.hypot(gg.slot.x - me.x, gg.slot.z - me.z);
    if (!gg.arrived) {
      if (d <= 0.9 || (walker.idle && d <= 2.0)) {
        gg.arrived = true;
        walker.stayAt(d <= 2.0 ? gg.slot : { x: me.x, z: me.z });
        this.world.faceTo(gg.g.center);
        gg.nextGestureAt = now + 8_000 + this.rng() * 20_000;
      } else if (walker.idle) {
        // Não chegou (preso, vaga tomada por um jogador): desiste desta.
        this.leaveGathering(true);
      }
      return;
    }
    // Sozinho na rodinha por mais de meio minuto: dispersa.
    if (gg.g.members.size <= 1 && now - gg.g.openedAt > 30_000 && this.rng() < 0.2) { this.leaveGathering(true); return; }
    if (now >= gg.nextGestureAt) {
      gg.nextGestureAt = now + 15_000 + this.rng() * 30_000;
      walker.emote(GESTURES[Math.floor(this.rng() * GESTURES.length)]!);
      this.later(3_000, () => walker.emote('idle'));
    }
  }

  private leaveGathering(resume: boolean): void {
    const gg = this.gathering;
    if (!gg) return;
    GATHERINGS.leave(gg.g, this.npc.id);
    this.gathering = null;
    this.gatherCooldownUntil = Date.now() + GATHER.cooldownMs;
    const me = this.world.position;
    if (resume && me) this.advance(me);
  }

  // ---------------------------------------------------------------- fala

  onChat(msg: ChatMessage): void {
    if (msg.system || msg.npc || msg.senderId === this.npc.id) return;
    if (!isAddressed(msg.text, this.npc.name)) return;
    const who = this.world.people().find((p) => p.userId === msg.senderId);
    if (!who || who.distance > CALL_M) return;
    this.world.attend(msg.senderId, TURN_MS);
    const lines = this.profile.lines ?? [];
    if (!lines.length) return;
    const now = Date.now();
    if (now - this.lastLineAt < LINE_GAP_MS) return;
    if (now - (this.lineAt.get(msg.senderId) ?? 0) < LINE_PER_PERSON_MS) return;
    const line = lines[this.lineIndex++ % lines.length]!;
    if (this.world.say(line)) {
      this.lastLineAt = now;
      this.lineAt.set(msg.senderId, now);
    }
  }

  onAppeared(_p: Nearby): void {}
  onGone(_p: Nearby): void {}
  onNotice(_code: string, _text: string): void {}

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.leaveGathering(false);
    AMBIENT_PEERS.delete(this.npc.id);
  }
}
