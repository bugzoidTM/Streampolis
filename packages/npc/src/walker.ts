import {
  FIXED_DT, MAX_SPEED, PLAY_AREA, PLAZA, SCENE_AREA, SCENE_COLLIDERS, PLAYER_RADIUS,
  penetrates, type Collider, type MoveIntent, type SceneId,
} from './shared.js';

/**
 * As pernas do personagem.
 *
 * O servidor é quem move (SPECs §21): daqui saem INTENÇÕES — direção, yaw,
 * andar/correr — e a posição verdadeira volta pelo estado da sala. Este
 * módulo não prevê nada; ele lê onde está, decide para onde ir e produz o
 * próximo lote de intenções. Ficar preso é detectado pelo que a sala
 * devolveu, não pelo que se pediu.
 *
 * Os destinos são os mesmos trajetos dos figurantes da praça (`PLAZA.crowd`):
 * já estão fora dos colisores e já têm "motivo visível" — atravessar, parar
 * perto do telão, esperar no quiosque. O desvio local é o mínimo que faz um
 * segmento reto não terminar dentro de um banco.
 */

export interface Point { x: number; z: number }

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
 *
 * Vale para qualquer personagem seguindo qualquer jogador: quem é seguido é
 * um `userId` lido da sala, e cada NPC tem o seu próprio Walker.
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
  private followed: (() => Point | null) | null = null;
  private followMoving = false;
  private followRunning = false;
  private followPausedUntil = 0;
  private throttle = 0;
  private lastYaw: number | null = null;
  /** Distância até quem é seguido, um ponto por lote (últimos ~1 s), para saber se ela se afasta. */
  private distTrail: number[] = [];

  constructor(private readonly sceneId: SceneId, destinations?: Point[]) {
    this.colliders = SCENE_COLLIDERS[sceneId] ?? [];
    const pool = destinations ?? (sceneId === 'central_plaza' ? plazaDestinations() : []);
    this.destinations = pool.filter((p) => !penetrates(p, this.colliders) && this.insideArea(p));
  }

  get destination(): Point | null {
    return this.target;
  }

  get idle(): boolean {
    return this.target === null && !this.followMoving;
  }

  get following(): boolean {
    return this.followed !== null;
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

  setTarget(p: Point | null): void {
    this.unfollow();
    this.target = p;
    this.facing = null;
    this.lastProgressAt = Date.now();
  }

  stop(): void {
    this.unfollow();
    this.target = null;
  }

  /**
   * Acompanhar alguém, mantendo distância natural (ver `FOLLOW`). `who` devolve
   * onde a pessoa está agora, ou nulo quando ela some da sala.
   */
  follow(who: () => Point | null): void {
    this.target = null;
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
   */
  intents(current: Point, steps: number): MoveIntent[] {
    if (this.followed) return this.followIntents(current, steps);
    const out: MoveIntent[] = [];
    if (!this.target) {
      if (this.facing !== null) {
        out.push({ dx: 0, dz: 0, yaw: this.facing, run: false, seq: ++this.seq });
        this.facing = null;
      }
      return out;
    }

    const dist = Math.hypot(this.target.x - current.x, this.target.z - current.z);
    if (dist <= ARRIVE_M) {
      this.target = null;
      return out;
    }

    // Preso? A sala devolveu (quase) a mesma posição por tempo demais.
    if (Math.hypot(current.x - this.lastPos.x, current.z - this.lastPos.z) > STUCK_EPS_M) {
      this.lastProgressAt = Date.now();
      this.lastPos = { ...current };
    } else if (Date.now() - this.lastProgressAt > STUCK_MS) {
      this.target = null;
      this.stuckCount++;
      return out;
    }

    const dir = this.steer(current, this.target);
    if (!dir) {
      this.target = null;
      this.stuckCount++;
      return out;
    }
    const yaw = Math.atan2(dir.x, dir.z);
    for (let i = 0; i < steps; i++) {
      out.push({ dx: dir.x, dz: dir.z, yaw, run: false, seq: ++this.seq });
    }
    return out;
  }

  stuckCount = 0;

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
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
