import type { Room } from 'colyseus.js';
import {
  MSG,
  PLAY_AREA,
  SCENE_AREA,
  SCENE_COLLIDERS,
  TICK_MS,
  type AnimState,
  type Area,
  type ChatMessage,
  type FollowEvent,
  type GiftEvent,
  type LikeTotals,
  type MoveCorrection,
  type PKResult,
  type SceneId,
  type StageInvite,
  type SystemNotice,
} from '@streampolis/shared';
import { RemoteBuffer } from './Interpolation.js';
import { Predictor } from './Predictor.js';
import type { LiveStateView, PlayerView, RenderPose, WorldStateView } from './types.js';

export interface WorldEvents {
  chat: (message: ChatMessage) => void;
  gift: (event: GiftEvent) => void;
  likes: (totals: LikeTotals) => void;
  follow: (event: FollowEvent) => void;
  notice: (notice: SystemNotice) => void;
  pkResult: (result: PKResult) => void;
  /** The host offered this client a seat on stage; it expires (SPECs §17). */
  stageInvite: (invite: StageInvite) => void;
  /** Fired after every state patch, for UI that mirrors room state. */
  state: (state: WorldStateView) => void;
  left: (code: number) => void;
  error: (code: number, message?: string) => void;
}

/**
 * Qualquer sala conectada, de cidade ou de live.
 *
 * O genérico do estado é invariante em TypeScript, então uma
 * `WorldConnection<LiveStateView>` não é atribuível a uma
 * `WorldConnection<WorldStateView>` mesmo tendo todos os campos. Quem só quer
 * "a sala em que estou" — o World, a ponte com as stores, a UI — usa este
 * união, que expõe exatamente os métodos comuns.
 */
export type AnyWorldConnection =
  | WorldConnection<WorldStateView>
  | WorldConnection<LiveStateView>;

export interface MoveInput {
  /** Planar direction in world space, magnitude 0..1. */
  dx: number;
  dz: number;
  /** Where the avatar faces, in radians. */
  yaw: number;
  run: boolean;
}

/** Yaw change below this is camera noise, not an intent worth a packet. */
const YAW_EPSILON = 0.02;

type Listener<K extends keyof WorldEvents> = WorldEvents[K];

/**
 * One joined room, from the browser's side.
 *
 * Owns the three things that make multiplayer feel right and are easy to get
 * wrong: a fixed-step intent stream (never per frame — a 144 Hz monitor would
 * otherwise move six times faster than a 24 Hz one), prediction for the local
 * avatar, and a delay buffer for everyone else.
 */
export class WorldConnection<S extends WorldStateView = WorldStateView> {
  readonly predictor: Predictor;
  /** Cena cuja planta o preditor está usando agora. Ver `adoptScene`. */
  private scene: SceneId = 'central_plaza';
  /**
   * Resolve no primeiro patch de estado.
   *
   * `join` volta assim que o assento é aceito, e nesse instante `room.state`
   * ainda é o schema com os DEFAULTS: perguntar a ele em que cena estamos
   * responde "central_plaza" mesmo dentro de uma live. Quem depende do estado
   * — construir a cena certa, por exemplo — espera aqui.
   */
  readonly ready: Promise<void>;

  private buffers = new Map<string, RemoteBuffer>();
  private listeners: { [K in keyof WorldEvents]: Set<Listener<K>> } = {
    chat: new Set(), gift: new Set(), likes: new Set(), follow: new Set(),
    notice: new Set(), pkResult: new Set(), stageInvite: new Set(),
    state: new Set(), left: new Set(), error: new Set(),
  };
  private accumulator = 0;
  private lastSentYaw = 0;
  private wasMoving = false;
  private disposed = false;

  private markReady: () => void = () => {};

  /**
   * `apartmentId` é a casa em que esta conexão realmente entrou.
   *
   * Existe porque `me` não é um id: a URL e a porta do saguão dizem "a minha
   * casa", e quem traduz isso para o id de verdade é `resolveApartment`, uma
   * vez, antes de abrir a sala. Sem guardar a resposta aqui, a interface ficava
   * com a palavra `me` na mão — e a barra de decoração perguntava `/homes/me`
   * à API, levava 404, engolia o erro e concluía que a casa não era do
   * jogador. O botão "Decorar" simplesmente não aparecia na própria casa.
   */
  constructor(readonly room: Room<S>, readonly apartmentId: string | null = null) {
    this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
    this.predictor = new Predictor(
      { x: 0, z: 0, yaw: 0, moving: false },
      PLAY_AREA.central_plaza,
      SCENE_COLLIDERS.central_plaza,
      SCENE_AREA.central_plaza ?? null,
    );
    this.wire();
  }

  /**
   * Ensina ao preditor a PLANTA da cena em que esta sala realmente está.
   *
   * Existe separado do construtor porque ali a resposta ainda não chegou: o
   * estado da sala só ganha valor no primeiro patch, e antes dele
   * `room.state.sceneId` é o DEFAULT do schema — 'central_plaza'. O construtor
   * lia esse default e o preditor passava a vida inteira prevendo com a mesa de
   * colisão da praça. Dentro de um apartamento isso não é um detalhe: o
   * monumento da praça é um cilindro de 5,26 m no centro do mundo, e o quarto
   * inteiro cabe dentro dele — o primeiro passo empurrava o jogador para fora
   * desse cilindro, ou seja, através da parede, e nada o trazia de volta,
   * porque o servidor só manda correção quando ELE recusa alguma coisa, e ele
   * não recusara nada: do lado de lá o corpo continuava na sala.
   */
  private adoptScene(sceneId: SceneId): void {
    if (sceneId === this.scene) return;
    this.scene = sceneId;
    this.predictor.setArea(
      PLAY_AREA[sceneId],
      SCENE_COLLIDERS[sceneId],
      SCENE_AREA[sceneId] ?? null,
    );
  }

  get sessionId(): string {
    return this.room.sessionId;
  }

  /**
   * A planta com que o CORPO local é resolvido: a cena que o preditor adotou e
   * o limite andável dela.
   *
   * Publicado porque a divergência entre "a cena que eu desenho" e "a cena em
   * que eu colido" não tem sintoma nenhum até o jogador andar — e aí ele
   * atravessa uma parede. `tools/room-walls-check.mjs` compara as duas.
   */
  get collision(): { scene: SceneId; area: Area | null } {
    return { scene: this.scene, area: SCENE_AREA[this.scene] ?? null };
  }

  get state(): S {
    return this.room.state;
  }

  /** The local player's server-side entry, absent for live spectators. */
  get localPlayer(): PlayerView | undefined {
    return this.room.state?.players?.get(this.room.sessionId);
  }

  on<K extends keyof WorldEvents>(event: K, listener: Listener<K>): () => void {
    this.listeners[event].add(listener);
    return () => { this.listeners[event].delete(listener); };
  }

  private emit<K extends keyof WorldEvents>(event: K, ...args: Parameters<Listener<K>>): void {
    for (const listener of this.listeners[event]) {
      (listener as (...a: Parameters<Listener<K>>) => void)(...args);
    }
  }

  private wire(): void {
    this.room.onMessage(MSG.chatMessage, (m: ChatMessage) => this.emit('chat', m));
    this.room.onMessage(MSG.giftEvent, (e: GiftEvent) => this.emit('gift', e));
    this.room.onMessage(MSG.likeTotals, (t: LikeTotals) => this.emit('likes', t));
    this.room.onMessage(MSG.follow, (f: FollowEvent) => this.emit('follow', f));
    this.room.onMessage(MSG.notice, (n: SystemNotice) => this.emit('notice', n));
    this.room.onMessage(MSG.pkResult, (r: PKResult) => this.emit('pkResult', r));
    this.room.onMessage(MSG.stageInvite, (i: StageInvite) => this.emit('stageInvite', i));
    this.room.onMessage(MSG.correction, (c: MoveCorrection) => this.predictor.reconcile(c));

    let placed = false;
    this.room.onStateChange((state) => {
      this.markReady();
      // Antes de qualquer previsão: em que cena esta sala está. O primeiro
      // patch é quem responde, e é ele quem dá a mesa de colisão ao preditor.
      this.adoptScene(state.sceneId ?? 'central_plaza');
      const now = performance.now();
      state.players?.forEach((player, sessionId) => {
        if (sessionId === this.room.sessionId) {
          // The first patch carries the spawn the server chose; adopt it once,
          // then never again — after that the predictor is ahead on purpose.
          if (!placed) {
            this.predictor.place({ x: player.x, z: player.z, yaw: player.yaw, moving: false });
            this.lastSentYaw = player.yaw;
            placed = true;
          }
          return;
        }
        let buffer = this.buffers.get(sessionId);
        if (!buffer) this.buffers.set(sessionId, (buffer = new RemoteBuffer()));
        buffer.push({ t: now, x: player.x, y: player.y, z: player.z, yaw: player.yaw });
      });

      // Forget buffers of players who left, otherwise a long session leaks one
      // ring buffer per visitor the room ever had.
      for (const sessionId of [...this.buffers.keys()]) {
        if (!state.players?.get(sessionId)) this.buffers.delete(sessionId);
      }
      this.emit('state', state);
    });

    this.room.onLeave((code) => { this.disposed = true; this.emit('left', code); });
    this.room.onError((code, message) => this.emit('error', code, message));
  }

  /**
   * Advances the intent clock. Call once per rendered frame with the real
   * frame time; the fixed accumulator does the rest.
   */
  update(dtSeconds: number, input: MoveInput): void {
    if (this.disposed) return;
    // A tab that was backgrounded returns with a huge dt. Replaying it would
    // fire a burst the server's flood guard rejects — drop the debt instead.
    this.accumulator = Math.min(this.accumulator + dtSeconds * 1000, TICK_MS * 4);

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      const moving = Math.hypot(input.dx, input.dz) > 1e-3;
      const turned = Math.abs(input.yaw - this.lastSentYaw) > YAW_EPSILON;

      // Standing still costs nothing on the wire: no intents means the server
      // marks the player idle on its own. The one exception is the step right
      // after stopping, which has to travel or the avatar keeps walking there.
      if (!moving && !turned && !this.wasMoving) continue;

      const intent = this.predictor.step(input.dx, input.dz, input.yaw, input.run);
      this.room.send(MSG.move, intent);
      this.lastSentYaw = input.yaw;
      this.wasMoving = moving;
    }
  }

  /** Poses to draw this frame: local predicted, remote interpolated. */
  poses(now = performance.now()): RenderPose[] {
    const out: RenderPose[] = [];
    const state = this.room.state;
    if (!state?.players) return out;

    state.players.forEach((player, sessionId) => {
      if (sessionId === this.room.sessionId) {
        const local = this.predictor.current;
        out.push({
          ...toRenderPose(player, sessionId, true),
          x: local.x,
          z: local.z,
          yaw: local.yaw,
          moving: local.moving,
        });
        return;
      }
      const sample = this.buffers.get(sessionId)?.sample(now);
      out.push({
        ...toRenderPose(player, sessionId, false),
        x: sample?.x ?? player.x,
        y: sample?.y ?? player.y,
        z: sample?.z ?? player.z,
        yaw: sample?.yaw ?? player.yaw,
      });
    });
    return out;
  }

  // ---- intents the UI sends -------------------------------------------------

  /**
   * Reapresenta o token recém-assinado para a sala repintar o avatar.
   *
   * A aparência entrava na sala uma vez, no join: quem trocava de roupa
   * continuava com a antiga para todo mundo até reconectar. Aqui vai o TOKEN,
   * não a roupa — quem valida posse é a API, e o servidor confere a assinatura.
   */
  restyle(token: string): void {
    this.room.send(MSG.restyle, { token });
  }

  chat(text: string): void {
    this.room.send(MSG.chat, { text });
  }

  emote(anim: AnimState): void {
    this.room.send(MSG.emote, { anim });
  }

  like(count = 1): void {
    this.room.send(MSG.like, { count });
  }

  /**
   * Sends a gift. The key is generated here and MUST be reused verbatim on a
   * retry — that is what makes a resend free instead of a second charge
   * (SPECs §27). The client never claims an amount; the server prices it.
   */
  gift(giftId: string, quantity: number, idempotencyKey = newIdempotencyKey()): string {
    this.room.send(MSG.gift, { giftId, quantity, idempotencyKey });
    return idempotencyKey;
  }

  startPK(opponentId: string): void {
    this.room.send(MSG.startPK, { opponentId });
  }

  /** Host only: offers the stage to a spectator, who still has to accept. */
  inviteToStage(userId: string): void {
    this.room.send(MSG.invite, { userId });
  }

  acceptStage(): void {
    this.room.send(MSG.acceptStage, {});
  }

  leaveStage(): void {
    this.room.send(MSG.leaveStage, {});
  }

  endLive(): void {
    this.room.send(MSG.endLive, {});
  }

  block(userId: string, on = true): void {
    this.room.send(MSG.block, { userId, on });
  }

  async leave(): Promise<void> {
    this.disposed = true;
    this.buffers.clear();
    await this.room.leave();
  }
}

function toRenderPose(player: PlayerView, sessionId: string, isLocal: boolean): RenderPose {
  return {
    id: player.id,
    sessionId,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    anim: player.anim,
    moving: player.moving,
    gifterLevel: player.gifterLevel,
    avatar: player.avatar,
    isLocal,
  };
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
