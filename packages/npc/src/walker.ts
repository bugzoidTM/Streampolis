import {
  FIXED_DT, MAX_SPEED, PLAY_AREA, PLAZA, SCENE_AREA, SCENE_COLLIDERS, PLAYER_RADIUS,
  penetrates, type AnimState, type Collider, type MoveIntent, type SceneId,
} from './shared.js';

/**
 * As pernas (e a postura) do personagem.
 *
 * O servidor é quem move (SPECs §21): daqui saem INTENÇÕES — direção, yaw,
 * andar/correr — e a posição verdadeira volta pelo estado da sala. Este
 * módulo não prevê nada; ele lê onde está, decide para onde ir e produz o
 * próximo lote de intenções. Ficar preso é detectado pelo que a sala
 * devolveu, não pelo que se pediu.
 *
 * Tudo o que reage à posição de ALGUÉM mora aqui, e não no cérebro: o cérebro
 * tica a cada 2 s, as pernas a 8 Hz. Seguir, guiar esperando quem ficou para
 * trás, virar-se para quem fala e os microgestos de quem está parado são
 * comportamento de corpo — nenhum modelo de linguagem decide isso.
 *
 * Os destinos são os mesmos trajetos dos figurantes da praça (`PLAZA.crowd`):
 * já estão fora dos colisores e já têm "motivo visível" — atravessar, parar
 * perto do telão, esperar no quiosque. O desvio local é o mínimo que faz um
 * segmento reto não terminar dentro de um banco.
 *
 * Vale para qualquer personagem com qualquer jogador: quem é seguido, guiado
 * ou ouvido é um `sessionId` lido da sala, e cada NPC tem o seu próprio Walker.
 */

export interface Point { x: number; z: number }
/** Alguém na sala: onde está e como a sala o identifica. */
export interface Someone extends Point { sessionId: string }
/** Quem está por perto, para os microgestos (olhar para alguém). */
export type Senses = () => Someone[];

const ARRIVE_M = 0.45;
/** Sem sair do lugar por este tempo, com intenção de andar, é "preso". */
const STUCK_MS = 2_500;
const STUCK_EPS_M = 0.05;

/**
 * Acompanhar alguém: uma faixa, não um ponto. Para ao entrar em NEAR, só volta
 * a andar quando a pessoa sai de FAR (histerese — sem isso ele dá passinhos a
 * cada metro), e no trecho SLOW acima de NEAR chega desacelerando em vez de
 * frear em cima da pessoa. Correr só quando ela já ficou longe de verdade:
 * correndo, o jogador faz 5,2 m/s e um personagem andando faz 2,4.
 */
export const FOLLOW = {
  near: 2.0,
  far: 3.0,
  slow: 1.5,
  minThrottle: 0.3,
  /** Corre quando a pessoa está além disto E se afastando (ganhou `recedeM` no último segundo)... */
  runFrom: 6,
  recedeM: 1.0,
  /** ...ou quando já ficou longe demais, esteja parada ou não. */
  runFar: 14,
  walkBelow: 5,
  /** Parado: vira-se de novo se a pessoa mudou de lado mais do que isto (rad). */
  turnEps: 0.25,
  /** Preso atrás de algo: espera este tempo antes de tentar de novo. */
  stuckPauseMs: 2_000,
} as const;

/**
 * Guiando alguém até um lugar: se a pessoa fica para trás além de WAIT, ele
 * para, vira-se para ela e espera; retoma quando ela chega a RESUME. Sem
 * teleporte — quem ficou para trás precisa andar até ele.
 */
export const ESCORT = { waitM: 9, resumeM: 6 } as const;

/** "Fique aqui": se for empurrado (ou puxado por uma conversa) além disto, volta ao ponto. */
export const STAY_DRIFT_M = 2.5;

/**
 * Microgestos de quem está parado sem conversar. Nenhum é animação nova: só
 * o yaw (olhar ao redor), o alvo do Head Look (observar alguém perto) e um
 * meio passo de lado (mudar o apoio). O intervalo é aleatório para não virar
 * um relógio.
 */
export const IDLE = {
  minGapMs: 5_000,
  maxGapMs: 14_000,
  /** Virar a cabeça/corpo entre estes ângulos (rad), para um lado ou outro. */
  glanceMin: 0.35,
  glanceMax: 0.9,
  /** Quantos rad por tique ao virar: uma virada de 0,6 rad leva ~0,5 s. */
  turnStep: 0.05,
  /** Observar alguém a até esta distância, por este tempo. */
  watchM: 8,
  watchMinMs: 2_500,
  watchMaxMs: 6_000,
  /** O meio passo de lado: distância e acelerador. */
  shiftM: 0.15,
  shiftThrottle: 0.5,
} as const;

interface Attention { who: () => Someone | null; until: number }
interface Escort { dest: Point; who: () => Someone | null; waiting: boolean }
interface SeatSpot { at: Point; yaw: number }

type IdleGesture =
  | { kind: 'glance'; targetYaw: number }
  | { kind: 'watch'; who: Someone; until: number }
  | { kind: 'shift'; dir: Point; ticks: number; back: boolean };

export function plazaDestinations(): Point[] {
  const out: Point[] = [];
  const colliders = SCENE_COLLIDERS.central_plaza;
  for (const routine of PLAZA.crowd) {
    // Quem SENTA está em cima do banco — dentro do colisor. Um figurante
    // atravessa o banco para sentar; um corpo de verdade não passa. Ficam só
    // os pontos em que dá para chegar andando.
    if (routine.kind === 'sit') continue;
    for (const wp of routine.path) {
      const p = { x: wp.x, z: wp.z };
      if (!penetrates(p, colliders)) out.push(p);
    }
  }
  return out;
}

export class Walker {
  private target: Point | null = null;
  private seq = 0;
  private lastProgressAt = Date.now();
  private lastPos: Point = { x: 0, z: 0 };
  private readonly colliders: readonly Collider[];
  private readonly destinations: Point[];
  /** Para onde olhar quando parado (ex.: quem está falando). */
  private facing: number | null = null;
  /** Quem acompanhar: a posição VIVA, lida a cada lote (o cérebro tica a cada 2 s; as pernas, a 8 Hz). */
  private followed: (() => Someone | null) | null = null;
  private followMoving = false;
  private followRunning = false;
  private followPausedUntil = 0;
  private throttle = 0;
  private lastYaw: number | null = null;
  /** Distância até quem é seguido, um ponto por lote (últimos ~1 s), para saber se ela se afasta. */
  private distTrail: number[] = [];
  /** Conversa: parado, corpo e olhar em quem fala; o resto fica suspenso e volta depois. */
  private attention: Attention | null = null;
  private escort: Escort | null = null;
  /** "Fique aqui": o ponto ao qual voltar se for tirado dele. */
  private stayAnchor: Point | null = null;
  /** Sentar: a vaga escolhida; `seatedFlag` depois de o gesto ter sido pedido. */
  private seat: SeatSpot | null = null;
  private seatedFlag = false;
  /** O acompanhamento suspenso para sentar junto de quem ele segue; volta ao levantar. */
  private suspendedFollow: (() => Someone | null) | null = null;
  private senses: Senses = () => [];
  private idleNextAt = 0;
  private gesture: IdleGesture | null = null;
  /** Saídas além das intenções de movimento, drenadas por quem fala com a sala. */
  private lookWanted: string | null = null;
  private emoteQueue: AnimState[] = [];

  constructor(private readonly sceneId: SceneId, destinations?: Point[]) {
    this.colliders = SCENE_COLLIDERS[sceneId] ?? [];
    const pool = destinations ?? (sceneId === 'central_plaza' ? plazaDestinations() : []);
    this.destinations = pool.filter((p) => !penetrates(p, this.colliders) && this.insideArea(p));
    this.idleNextAt = Date.now() + IDLE.minGapMs;
  }

  /** Quem está por perto, para os microgestos. */
  sense(senses: Senses): void {
    this.senses = senses;
  }

  get destination(): Point | null {
    return this.target;
  }

  /** Sem destino nem acompanhamento em curso (parado, ou só em microgestos). */
  get idle(): boolean {
    return this.target === null && !this.followMoving && !this.seat;
  }

  get following(): boolean {
    return this.followed !== null || this.suspendedFollow !== null;
  }

  get escorting(): boolean {
    return this.escort !== null;
  }

  get attending(): boolean {
    return this.attention !== null;
  }

  get staying(): boolean {
    return this.stayAnchor !== null;
  }

  /** Já pediu o gesto de sentar (e não levantou). */
  get seated(): boolean {
    return this.seatedFlag;
  }

  /** Indo sentar ou sentado. */
  get sitting(): boolean {
    return this.seat !== null;
  }

  /** Para quem o corpo quer olhar agora (sessionId), ou ninguém em especial. */
  get look(): string | null {
    return this.lookWanted;
  }

  /** O gesto pedido, se houver — quem fala com a sala manda quando o corpo estiver parado. */
  takeEmote(): AnimState | null {
    return this.emoteQueue.shift() ?? null;
  }

  /** Escolhe um destino novo, longe o bastante para valer a caminhada. */
  pickDestination(from: Point, rng: () => number = Math.random): Point | null {
    const far = this.destinations.filter((d) => Math.hypot(d.x - from.x, d.z - from.z) > 6);
    const pool = far.length ? far : this.destinations;
    if (!pool.length) return null;
    const d = pool[Math.floor(rng() * pool.length)]!;
    this.setTarget(d);
    return d;
  }

  /** Ir a um ponto. Cancela seguir, guiar e sentar; `stay` continua (é a ordem em vigor). */
  setTarget(p: Point | null): void {
    this.unfollow();
    this.suspendedFollow = null;
    this.escort = null;
    this.standUp();
    this.target = p;
    this.facing = null;
    this.gesture = null;
    this.lastProgressAt = Date.now();
  }

  /** Parar tudo o que era ordem de movimento (seguir, guiar, ir, sentar). A atenção de uma conversa fica. */
  stop(): void {
    this.unfollow();
    this.suspendedFollow = null;
    this.escort = null;
    this.standUp();
    this.target = null;
    this.gesture = null;
  }

  /** Solta também o "fique aqui". */
  release(): void {
    this.stop();
    this.stayAnchor = null;
  }

  /**
   * Acompanhar alguém, mantendo distância natural (ver `FOLLOW`). `who` devolve
   * onde a pessoa está agora, ou nulo quando ela some da sala. Persistente:
   * só termina por `stop`/`release`/outra ordem.
   */
  follow(who: () => Someone | null): void {
    this.stop();
    this.stayAnchor = null;
    this.facing = null;
    this.followed = who;
    this.followMoving = false;
    this.followRunning = false;
    this.followPausedUntil = 0;
    this.throttle = 0;
    this.lastYaw = null;
    this.distTrail = [];
    this.lastProgressAt = Date.now();
  }

  private unfollow(): void {
    this.followed = null;
    this.followMoving = false;
    this.followRunning = false;
    this.throttle = 0;
  }

  /** Levar alguém a um lugar (ver `ESCORT`); sem `who`, é só ir. */
  guide(dest: Point, who: (() => Someone | null) | null): void {
    this.setTarget(dest);
    this.stayAnchor = null;
    if (who) this.escort = { dest, who, waiting: false };
  }

  /** "Fique aqui": parado onde está, voltando ao ponto se for tirado dele. Persistente. */
  stayAt(anchor: Point): void {
    this.stop();
    this.stayAnchor = { ...anchor };
  }

  /**
   * Alguém fala com ele: parar, corpo e olhar na pessoa enquanto durar. O que
   * estava fazendo (seguir, guiar, ir) fica suspenso e volta ao terminar —
   * é a conversa que interrompe, não a ordem que acaba.
   */
  attend(who: () => Someone | null, ms: number): void {
    this.attention = { who, until: Date.now() + ms };
    this.gesture = null;
    this.throttle = 0;
    this.followMoving = false;
    this.followRunning = false;
  }

  /** Ir sentar numa vaga: anda até ela, vira de costas para o banco e pede o gesto. */
  sitAt(seat: SeatSpot): void {
    if (this.followed) this.suspendedFollow = this.followed;
    this.unfollow();
    this.escort = null;
    this.target = { ...seat.at };
    this.seat = { at: { ...seat.at }, yaw: seat.yaw };
    this.seatedFlag = false;
    this.gesture = null;
    this.lastProgressAt = Date.now();
  }

  /** Levantar: o gesto `idle` sai na hora; o que estava suspenso (seguir) volta. */
  standUp(): void {
    if (!this.seat) return;
    const wasSeated = this.seatedFlag;
    this.seat = null;
    this.seatedFlag = false;
    this.target = null;
    if (wasSeated) this.emoteQueue.push('idle');
    if (this.suspendedFollow) {
      const who = this.suspendedFollow;
      this.suspendedFollow = null;
      this.follow(who);
    }
  }

  /**
   * Parado, virado para um ponto (quem fala com ele). Acompanhando alguém, a
   * virada vale enquanto ele estiver parado — o acompanhamento continua.
   */
  face(toward: Point, from: Point): void {
    this.target = null;
    this.facing = Math.atan2(toward.x - from.x, toward.z - from.z);
  }

  /**
   * Um lote de intenções para os próximos `steps` tiques, a partir de onde a
   * sala diz que o corpo está. Vazio = parado (a sala não precisa de intenção
   * para ficar parado; mandar `dx=dz=0` só serve para virar o yaw).
   *
   * Prioridade: conversa > sentado > ir sentar > seguir > guiar/ir > voltar ao
   * ponto do "fique aqui" > microgestos.
   */
  intents(current: Point & { yaw?: number }, steps: number): MoveIntent[] {
    const now = Date.now();
    this.lookWanted = null;
    if (this.lastYaw === null && typeof current.yaw === 'number') this.lastYaw = current.yaw;

    if (this.attention) {
      if (now >= this.attention.until) {
        this.attention = null;
        this.idleNextAt = now + IDLE.minGapMs;
      } else {
        const who = this.attention.who();
        if (!who) { this.attention = null; return []; }
        this.lookWanted = who.sessionId;
        // Sentado, só o olhar acompanha: virar o corpo é levantar.
        if (this.seatedFlag) return [];
        return this.turnToward(current, who);
      }
    }

    if (this.seat) return this.sitIntents(current, steps);
    if (this.followed) return this.followIntents(current, steps);

    const out: MoveIntent[] = [];
    if (!this.target) {
      if (this.stayAnchor && Math.hypot(this.stayAnchor.x - current.x, this.stayAnchor.z - current.z) > STAY_DRIFT_M) {
        // Tirado do lugar onde mandaram ficar: volta.
        this.target = { ...this.stayAnchor };
        this.lastProgressAt = now;
        this.lastPos = { ...current };
        return this.walkIntents(current, steps);
      }
      if (this.facing !== null) {
        out.push({ dx: 0, dz: 0, yaw: this.facing, run: false, seq: ++this.seq });
        this.lastYaw = this.facing;
        this.facing = null;
        return out;
      }
      return this.idleIntents(current, steps, now);
    }

    if (this.escort) {
      const who = this.escort.who();
      if (!who) {
        // Quem estava sendo guiado sumiu: chega sozinho.
        this.escort = null;
      } else {
        const d = Math.hypot(who.x - current.x, who.z - current.z);
        if (!this.escort.waiting && d > ESCORT.waitM) this.escort.waiting = true;
        else if (this.escort.waiting && d <= ESCORT.resumeM) {
          this.escort.waiting = false;
          this.lastProgressAt = now;
          this.lastPos = { ...current };
        }
        if (this.escort.waiting) {
          this.lookWanted = who.sessionId;
          return this.turnToward(current, who);
        }
      }
    }

    return this.walkIntents(current, steps);
  }

  /** Andar até `target` (reta com desvio local), com detecção de preso. */
  private walkIntents(current: Point, steps: number): MoveIntent[] {
    const out: MoveIntent[] = [];
    const target = this.target!;
    const dist = Math.hypot(target.x - current.x, target.z - current.z);
    if (dist <= ARRIVE_M) {
      this.target = null;
      this.escort = null;
      this.idleNextAt = Date.now() + IDLE.minGapMs;
      return out;
    }

    // Preso? A sala devolveu (quase) a mesma posição por tempo demais.
    if (Math.hypot(current.x - this.lastPos.x, current.z - this.lastPos.z) > STUCK_EPS_M) {
      this.lastProgressAt = Date.now();
      this.lastPos = { ...current };
    } else if (Date.now() - this.lastProgressAt > STUCK_MS) {
      this.target = null;
      this.escort = null;
      this.stuckCount++;
      return out;
    }

    const dir = this.steer(current, target);
    if (!dir) {
      this.target = null;
      this.escort = null;
      this.stuckCount++;
      return out;
    }
    const yaw = Math.atan2(dir.x, dir.z);
    this.lastYaw = yaw;
    for (let i = 0; i < steps; i++) {
      out.push({ dx: dir.x, dz: dir.z, yaw, run: false, seq: ++this.seq });
    }
    return out;
  }

  stuckCount = 0;

  /** Parado, virando o corpo para alguém (só quando a direção mudou de verdade). */
  private turnToward(current: Point, who: Point): MoveIntent[] {
    const want = Math.atan2(who.x - current.x, who.z - current.z);
    if (this.lastYaw === null || Math.abs(angleDiff(want, this.lastYaw)) > FOLLOW.turnEps) {
      this.lastYaw = want;
      return [{ dx: 0, dz: 0, yaw: want, run: false, seq: ++this.seq }];
    }
    return [];
  }

  /** As pernas acompanhando alguém: faixa de distância, aceleração suave, histerese. */
  private followIntents(current: Point, steps: number): MoveIntent[] {
    const out: MoveIntent[] = [];
    const who = this.followed!();
    if (!who) {
      // Sumiu da sala: fica parado onde está; o cérebro decide o que fazer.
      this.followMoving = false;
      this.throttle = 0;
      return out;
    }
    this.lookWanted = who.sessionId;
    const now = Date.now();
    const dist = Math.hypot(who.x - current.x, who.z - current.z);
    const toward = Math.atan2(who.x - current.x, who.z - current.z);
    // Um segundo de lotes: 8 a 3 tiques de 24 Hz.
    this.distTrail.push(dist);
    if (this.distTrail.length > 8) this.distTrail.shift();
    const receding = dist - this.distTrail[0]! > FOLLOW.recedeM;

    // Histerese: para ao entrar em NEAR, só retoma além de FAR.
    if (this.followMoving && dist <= FOLLOW.near) {
      this.followMoving = false;
      this.followRunning = false;
      this.throttle = 0;
      this.facing = toward;
    } else if (!this.followMoving && dist > FOLLOW.far && now >= this.followPausedUntil) {
      this.followMoving = true;
      this.lastProgressAt = now;
      this.lastPos = { ...current };
    }

    if (!this.followMoving) {
      // Parado: acompanha a pessoa com o olhar quando ela muda de lado.
      const want = this.facing ?? toward;
      if (this.lastYaw === null || Math.abs(angleDiff(want, this.lastYaw)) > FOLLOW.turnEps) {
        out.push({ dx: 0, dz: 0, yaw: want, run: false, seq: ++this.seq });
        this.lastYaw = want;
      }
      this.facing = null;
      return out;
    }

    // Preso (banco, árvore, outra pessoa): pausa, vira para quem segue e tenta depois.
    if (Math.hypot(current.x - this.lastPos.x, current.z - this.lastPos.z) > STUCK_EPS_M) {
      this.lastProgressAt = now;
      this.lastPos = { ...current };
    } else if (now - this.lastProgressAt > STUCK_MS) {
      return this.pauseFollow(now, toward);
    }

    const dir = this.steer(current, who);
    if (!dir) return this.pauseFollow(now, toward);

    // Correr só atrás de quem se afasta (ou já ficou longe demais); voltar a andar bem antes de chegar.
    if (dist > FOLLOW.runFar || (dist > FOLLOW.runFrom && receding)) this.followRunning = true;
    else if (dist < FOLLOW.walkBelow) this.followRunning = false;

    // Alvo de velocidade: cheio longe, decrescendo na faixa SLOW até o mínimo em NEAR.
    const want = Math.max(FOLLOW.minThrottle, Math.min(1, (dist - FOLLOW.near) / FOLLOW.slow));
    // Suavização por lote (8 lotes/s): ~0,5 s para ir de parado a cheio, sem trancos.
    this.throttle += (want - this.throttle) * 0.4;
    const t = Math.max(FOLLOW.minThrottle, Math.min(1, this.throttle));

    const yaw = Math.atan2(dir.x, dir.z);
    this.lastYaw = yaw;
    for (let i = 0; i < steps; i++) {
      out.push({ dx: dir.x * t, dz: dir.z * t, yaw, run: this.followRunning, seq: ++this.seq });
    }
    return out;
  }

  private pauseFollow(now: number, toward: number): MoveIntent[] {
    this.stuckCount++;
    this.followMoving = false;
    this.followRunning = false;
    this.throttle = 0;
    this.followPausedUntil = now + FOLLOW.stuckPauseMs;
    this.lastYaw = toward;
    return [{ dx: 0, dz: 0, yaw: toward, run: false, seq: ++this.seq }];
  }

  /** Indo sentar: anda até a vaga; chegando, vira de costas para o banco e pede o gesto. Sentado: nada. */
  private sitIntents(current: Point, steps: number): MoveIntent[] {
    const seat = this.seat!;
    if (this.seatedFlag) return [];
    if (this.target) {
      const out = this.walkIntents(current, steps);
      if (this.target || out.length) return out;
      // walkIntents desistiu (preso) sem chegar: fica em pé onde está.
      if (Math.hypot(seat.at.x - current.x, seat.at.z - current.z) > ARRIVE_M + 0.3) {
        this.seat = null;
        this.suspendedFollow = null;
        return out;
      }
    }
    // Chegou: vira e senta. O gesto sai quando a sala disser que o corpo parou.
    this.seatedFlag = true;
    this.lastYaw = seat.yaw;
    this.emoteQueue.push('sit');
    return [{ dx: 0, dz: 0, yaw: seat.yaw, run: false, seq: ++this.seq }];
  }

  /** Microgestos de quem está parado: olhar ao redor, observar alguém, mudar o apoio. */
  private idleIntents(current: Point, steps: number, now: number, rng: () => number = Math.random): MoveIntent[] {
    const g = this.gesture;
    if (g) {
      if (g.kind === 'glance') {
        const yaw = this.lastYaw ?? g.targetYaw;
        if (Math.abs(angleDiff(g.targetYaw, yaw)) < IDLE.turnStep) {
          this.gesture = null;
          this.lastYaw = g.targetYaw;
          return [{ dx: 0, dz: 0, yaw: g.targetYaw, run: false, seq: ++this.seq }];
        }
        const out: MoveIntent[] = [];
        let y = yaw;
        for (let i = 0; i < steps; i++) {
          const dd = angleDiff(g.targetYaw, y);
          if (Math.abs(dd) < IDLE.turnStep) break;
          y = wrap(y + Math.sign(dd) * IDLE.turnStep);
          out.push({ dx: 0, dz: 0, yaw: y, run: false, seq: ++this.seq });
        }
        this.lastYaw = y;
        return out;
      }
      if (g.kind === 'watch') {
        if (now >= g.until) { this.gesture = null; return []; }
        const who = this.senses().find((p) => p.sessionId === g.who.sessionId);
        if (!who || Math.hypot(who.x - current.x, who.z - current.z) > IDLE.watchM) { this.gesture = null; return []; }
        this.lookWanted = who.sessionId;
        // O corpo só acompanha se a pessoa saiu muito do campo de visão.
        const want = Math.atan2(who.x - current.x, who.z - current.z);
        if (this.lastYaw !== null && Math.abs(angleDiff(want, this.lastYaw)) > 1.0) {
          this.gesture = { kind: 'glance', targetYaw: want };
        }
        return [];
      }
      // shift: um meio passo para o lado e, no lote seguinte, de volta.
      const dir = g.back ? { x: -g.dir.x, z: -g.dir.z } : g.dir;
      const out: MoveIntent[] = [];
      const yaw = this.lastYaw ?? 0;
      for (let i = 0; i < Math.min(steps, g.ticks); i++) {
        out.push({ dx: dir.x * IDLE.shiftThrottle, dz: dir.z * IDLE.shiftThrottle, yaw, run: false, seq: ++this.seq });
      }
      this.gesture = g.back ? null : { ...g, back: true };
      return out;
    }

    if (now < this.idleNextAt) return [];
    this.idleNextAt = now + IDLE.minGapMs + rng() * (IDLE.maxGapMs - IDLE.minGapMs);
    const near = this.senses().filter((p) => Math.hypot(p.x - current.x, p.z - current.z) <= IDLE.watchM);
    const roll = rng();
    if (near.length && roll < 0.45) {
      const who = near[Math.floor(rng() * near.length)]!;
      this.gesture = { kind: 'watch', who, until: now + IDLE.watchMinMs + rng() * (IDLE.watchMaxMs - IDLE.watchMinMs) };
      const want = Math.atan2(who.x - current.x, who.z - current.z);
      if (this.lastYaw !== null && Math.abs(angleDiff(want, this.lastYaw)) > 1.0) this.gesture = { kind: 'glance', targetYaw: want };
      return this.idleIntents(current, steps, now, rng);
    }
    if (roll < 0.8 || this.lastYaw === null) {
      const base = this.lastYaw ?? 0;
      const amount = IDLE.glanceMin + rng() * (IDLE.glanceMax - IDLE.glanceMin);
      this.gesture = { kind: 'glance', targetYaw: wrap(base + (rng() < 0.5 ? amount : -amount)) };
      return this.idleIntents(current, steps, now, rng);
    }
    // Mudar o apoio: meio passo para um lado livre, curto o bastante para não virar caminhada.
    const side = rng() < 0.5 ? 1 : -1;
    const yaw = this.lastYaw ?? 0;
    const dir = { x: Math.cos(yaw) * side, z: -Math.sin(yaw) * side };
    const ticks = Math.max(1, Math.round(IDLE.shiftM / (MAX_SPEED.walk * IDLE.shiftThrottle * FIXED_DT)));
    const probe = { x: current.x + dir.x * (IDLE.shiftM + PLAYER_RADIUS), z: current.z + dir.z * (IDLE.shiftM + PLAYER_RADIUS) };
    if (penetrates(probe, this.colliders) || !this.insideArea(probe)) return [];
    this.gesture = { kind: 'shift', dir, ticks, back: false };
    return this.idleIntents(current, steps, now, rng);
  }

  /**
   * Direção do próximo passo. Reta se o próximo trecho não entra em nada;
   * senão tenta rodar a direção em ângulos crescentes para os dois lados.
   * Não é pathfinding — é o bastante para contornar um banco ou uma árvore,
   * que é tudo que a praça tem no caminho.
   */
  private steer(from: Point, to: Point): Point | null {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    const base = Math.atan2(dx, dz);
    // Olha alguns passos à frente, não só o próximo: um corpo a 2,4 m/s cruza
    // 10 cm por tique e um colisor de 30 cm caberia entre duas checagens.
    const lookahead = Math.min(len, MAX_SPEED.walk * FIXED_DT * 12);
    const angles = [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, Math.PI / 2, -Math.PI / 2];
    for (const a of angles) {
      const ang = base + a;
      const ux = Math.sin(ang);
      const uz = Math.cos(ang);
      const probe = { x: from.x + ux * lookahead, z: from.z + uz * lookahead };
      const near = { x: from.x + ux * PLAYER_RADIUS * 2, z: from.z + uz * PLAYER_RADIUS * 2 };
      if (!penetrates(probe, this.colliders) && !penetrates(near, this.colliders) && this.insideArea(probe)) {
        return { x: ux, z: uz };
      }
    }
    return null;
  }

  private insideArea(p: Point): boolean {
    const bounds = PLAY_AREA[this.sceneId];
    if (p.x < bounds.minX + 1 || p.x > bounds.maxX - 1 || p.z < bounds.minZ + 1 || p.z > bounds.maxZ - 1) return false;
    const area = SCENE_AREA[this.sceneId];
    if (!area) return true;
    if (area.kind === 'circle') return Math.hypot(p.x - area.x, p.z - area.z) < area.r - PLAYER_RADIUS;
    return Math.abs(p.x - area.x) < area.hw - PLAYER_RADIUS && Math.abs(p.z - area.z) < area.hd - PLAYER_RADIUS;
  }
}

/** Diferença angular em (-π, π]. */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function wrap(a: number): number {
  return angleDiff(a, 0);
}
