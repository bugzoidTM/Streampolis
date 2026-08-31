import * as THREE from 'three';
import {
  DEFAULT_AVATAR,
  GIFT_BY_ID,
  PLAY_AREA,
  applyMoveIntent,
  type AnimState,
  type AvatarConfig,
  type GiftEvent,
  type SceneId,
} from '@streampolis/shared';
import { Renderer } from './Renderer.js';
import { CameraManager } from './CameraManager.js';
import { InputManager } from './InputManager.js';
import { Avatar } from './avatar/Avatar.js';
import { NameTag, disposeNameTags } from './NameTag.js';
import { createScene } from './scenes/index.js';
import type { GameScene } from './scenes/GameScene.js';
import { clipReport, type ClipReport } from './anim/Library.js';
import { GiftEffectManager } from './fx/GiftEffects.js';
import type { AnyWorldConnection } from '../network/WorldConnection.js';
import type { RenderPose } from '../network/types.js';
import { attachStores } from '../network/bridge.js';

export interface WorldOptions {
  canvas: HTMLCanvasElement;
  /**
   * Sala JÁ CONECTADA. Quem escolhe em qual entrar é a camada de sessão
   * (network/session.ts), não o mundo: o mundo desenha a sala em que está.
   * Ausente = modo offline.
   */
  connection?: AnyWorldConnection | null;
  /** Só no offline: qual cena desenhar sem servidor nenhum. */
  sceneId?: SceneId;
  tier?: 'low' | 'medium' | 'high';
  /** Look used only in offline mode; online it comes signed in the token. */
  avatar?: AvatarConfig;
  displayName?: string;
}

interface Actor {
  /** Id do jogador (o da API), não o da sessão: é por ele que o presente chega. */
  userId: string;
  avatar: Avatar;
  /** Nulo no avatar local: ninguém precisa de uma placa com o próprio nome. */
  tag: NameTag | null;
  /** Smoothed yaw, so a remote turning in place does not snap. */
  yaw: number;
  /** Where this actor was drawn last frame, to measure its real speed. */
  last: THREE.Vector3;
  /** Smoothed ground speed in m/s; what the locomotion clips are timed to. */
  speed: number;
}

const LOCAL_ID = 'local';

/**
 * Wires engine, scene, input and network into a running world.
 *
 * Deliberately framework-free: React mounts it and gets out of the way. The
 * render loop must not go through a component tree — a state update per frame
 * is how a 60 FPS scene becomes a 20 FPS one.
 *
 * Without a token it runs offline: the same scene, the same camera and a local
 * avatar driven by the same `applyMoveIntent` the server would run. That is
 * what makes the plaza reviewable in a screenshot without booting a server.
 */
export class World {
  readonly renderer: Renderer;
  readonly camera: CameraManager;
  readonly input: InputManager;

  private scene: GameScene | null = null;
  private gifts: GiftEffectManager | null = null;
  private offGift: (() => void) | null = null;
  private sceneId: SceneId = 'central_plaza';
  /** The boom starts behind the avatar, once, on the first pose it sees. */
  private cameraAligned = false;
  /** Debug override from the screenshot tool; never set during play. */
  private forcedAnim: AnimState | null = null;
  private connection: AnyWorldConnection | null = null;
  private detachStores: (() => void) | null = null;
  private actors = new Map<string, Actor>();
  private clock = new THREE.Clock();
  private raf = 0;
  private frames = 0;
  private disposed = false;

  /** Offline pose, integrated locally with the server's own function. */
  private solo = { x: 0, z: 6, yaw: Math.PI, moving: false };
  private soloSeq = 0;

  constructor(private opts: WorldOptions) {
    this.renderer = new Renderer(opts.canvas, opts.tier);
    this.camera = new CameraManager(1);
    this.input = new InputManager(opts.canvas);
  }

  get online(): boolean {
    return this.connection !== null;
  }

  async start(): Promise<void> {
    // A sala chega pronta. O mundo não escolhe onde entrar — ele pergunta ao
    // estado da sala onde ELE está. Era esse o elo que faltava: com o World
    // abrindo a conexão sozinho, toda sala virava uma CityRoom e uma live
    // acontecia dentro da praça.
    this.connection = this.opts.connection ?? null;
    this.sceneId = this.connection?.state?.sceneId ?? this.opts.sceneId ?? 'central_plaza';

    if (this.connection) {
      this.detachStores = attachStores(this.connection);
    }

    const scene = createScene(this.sceneId);
    await scene.build(this.renderer.webgl);
    this.scene = scene;
    this.renderer.attach(scene.scene, this.camera.camera, scene.look);
    // Snapshot of the static world, taken before any avatar exists. Handing
    // the camera the live scene instead would raycast sprites and skinned
    // meshes every frame — Sprite.raycast needs a camera the boom does not
    // have, and it throws once per frame.
    this.camera.obstacles = [...scene.scene.children];
    this.camera.setFraming(scene.framing, true);
    this.camera.setLimits({ maxDistance: scene.maxBoom });

    this.gifts = new GiftEffectManager(scene.scene, {
      budget: this.renderer.quality.settings.particleBudget,
      shake: (amount) => this.camera.shake(amount),
      camera: () => this.camera.camera,
      viewHeight: () => this.opts.canvas.clientHeight || window.innerHeight,
    });
    // O presente só vira efeito depois de cobrado: este evento chega do
    // servidor DEPOIS do débito, e um replay nunca chega (SPECs §68 regra 4).
    this.offGift = this.connection?.on('gift', (event) => this.showGift(event)) ?? null;

    if (!this.connection) {
      const spawn = scene.spawnPoints[0] ?? new THREE.Vector3(0, 0, 6);
      this.solo = { x: spawn.x, z: spawn.z, yaw: Math.atan2(-spawn.x, -spawn.z), moving: false };
    }

    this.resize();
    this.loop();
  }

  /** Onde o efeito do presente cai: em cima de quem recebeu. */
  private showGift(event: GiftEvent): void {
    if (!this.gifts) return;
    const target = this.actorOfUser(event.receiverId);
    const at = target
      ? target.avatar.root.position.clone()
      // Sem corpo em cena (espectador presenteando o host de outra sala, ou um
      // host ainda não desenhado) o efeito acontece à frente da câmera, para
      // que um presente pago nunca seja invisível.
      : this.inFrontOfCamera();
    this.gifts.play(event, at);
  }

  private actorOfUser(userId: string): Actor | undefined {
    for (const [, actor] of this.actors) {
      if (actor.userId === userId) return actor;
    }
    return undefined;
  }

  private inFrontOfCamera(): THREE.Vector3 {
    const dir = new THREE.Vector3();
    this.camera.camera.getWorldDirection(dir);
    return this.camera.camera.position.clone().addScaledVector(dir, 4.5).setY(0);
  }

  resize(): void {
    const canvas = this.opts.canvas;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    this.renderer.resize(w, h);
    this.camera.resize(w, h);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    const input = this.input.poll();

    this.camera.applyInput(input.lookYaw, input.lookPitch, input.zoom * 0.01);

    // Movement is expressed against what the player actually sees, so it is
    // derived from the camera basis rather than from a yaw convention.
    const forward = new THREE.Vector3();
    this.camera.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);

    const dir = new THREE.Vector3()
      .addScaledVector(right, input.moveX)
      .addScaledVector(forward, -input.moveZ);
    const moving = dir.lengthSq() > 1e-6;
    if (moving) dir.normalize();
    // Face where you walk; standing still keeps the last facing.
    const yaw = moving ? Math.atan2(dir.x, dir.z) : this.facing();

    if (this.connection) {
      this.connection.update(dt, { dx: dir.x, dz: dir.z, yaw, run: input.run });
      this.syncActors(this.connection.poses(), dt);
    } else {
      this.stepSolo(dir.x, dir.z, yaw, input.run);
      this.syncActors([this.soloPose()], dt);
    }

    const me = this.actors.get(this.localKey());
    if (me) this.camera.follow(me.avatar.root.position);

    this.camera.update(dt);
    this.scene?.update(dt, this.camera.camera);
    this.gifts?.update(dt);
    this.renderer.render(dt);

    this.frames++;
    // The screenshot tool waits on this: post-processing shaders compile on
    // the first frames and an early capture catches an unshaded scene.
    if (this.frames === 12) (window as unknown as { __ready?: boolean }).__ready = true;
  };

  private facing(): number {
    const me = this.actors.get(this.localKey());
    return me ? me.yaw : this.solo.yaw;
  }

  private localKey(): string {
    return this.connection ? this.connection.sessionId : LOCAL_ID;
  }

  /** Offline integration — same function and same fixed step as the server. */
  private stepSolo(dx: number, dz: number, yaw: number, run: boolean): void {
    const next = applyMoveIntent(
      this.solo,
      { dx, dz, yaw, run, seq: ++this.soloSeq },
      PLAY_AREA[this.sceneId],
    );
    const clamped = this.scene?.clamp(
      new THREE.Vector3(this.solo.x, 0, this.solo.z),
      new THREE.Vector3(next.x, 0, next.z),
    );
    this.solo = {
      x: clamped ? clamped.x : next.x,
      z: clamped ? clamped.z : next.z,
      yaw: next.yaw,
      moving: next.moving,
    };
  }

  private soloPose(): RenderPose {
    return {
      id: LOCAL_ID,
      sessionId: LOCAL_ID,
      name: this.opts.displayName ?? 'Você',
      x: this.solo.x,
      y: 0,
      z: this.solo.z,
      yaw: this.solo.yaw,
      anim: this.solo.moving ? 'walk' : 'idle',
      moving: this.solo.moving,
      gifterLevel: 0,
      avatar: this.opts.avatar ?? DEFAULT_AVATAR,
      isLocal: true,
    };
  }

  /**
   * Reconciles the actor pool with this frame's poses. Avatars are built and
   * destroyed here and nowhere else, which is what keeps a busy plaza from
   * leaking a skinned mesh per visitor that ever passed through.
   */
  private syncActors(poses: RenderPose[], dt: number): void {
    const seen = new Set<string>();

    for (const pose of poses) {
      seen.add(pose.sessionId);
      let actor = this.actors.get(pose.sessionId);
      if (!actor) {
        const avatar = new Avatar(pose.avatar ?? DEFAULT_AVATAR);
        // O próprio jogador não ganha placa: em terceira pessoa ela fica entre
        // a câmera e a cabeça dele, e numa live tapa exatamente o que está
        // sendo transmitido.
        const tag = pose.isLocal
          ? null
          : new NameTag(pose.name, pose.gifterLevel, avatar.eyeHeight);
        if (tag) avatar.root.add(tag.sprite);
        this.scene?.scene.add(avatar.root);
        actor = {
          userId: pose.id,
          avatar, tag, yaw: pose.yaw,
          last: new THREE.Vector3(pose.x, pose.y, pose.z),
          speed: 0,
        };
        this.actors.set(pose.sessionId, actor);
      }

      // Speed is measured from what was actually drawn, not from the server's
      // `moving` flag: a remote arriving through the interpolation buffer moves
      // at the buffer's pace, and timing the walk to anything else is exactly
      // what makes feet skate.
      const travelled = Math.hypot(pose.x - actor.last.x, pose.z - actor.last.z);
      const instant = dt > 1e-4 ? travelled / dt : 0;
      // Half-life smoothing, so one dropped packet does not stop the legs.
      const k = 1 - Math.exp(-dt / 0.09);
      actor.speed += (Math.min(instant, 12) - actor.speed) * k;
      actor.last.set(pose.x, pose.y, pose.z);

      if (pose.isLocal && !this.cameraAligned) {
        // Atrás do jogador, olhando para onde ele olha. Deixar o braço em yaw 0
        // punha a câmera entre o host e o painel de LED em toda live room.
        //
        // Exceto no palco: quem transmite se vê como a plateia vê, de frente —
        // é o enquadramento de uma live, e é o único jeito de a pessoa saber o
        // que está indo ao ar.
        const role = this.connection?.localPlayer?.role;
        const onStage = role === 'host' || role === 'cohost';
        this.camera.yaw = onStage ? pose.yaw : pose.yaw + Math.PI;
        this.cameraAligned = true;
      }

      actor.avatar.root.position.set(pose.x, pose.y, pose.z);
      // Remote yaw already comes interpolated; this only damps the local
      // avatar's turn, which changes instantly with the input.
      actor.yaw = shortestLerp(actor.yaw, pose.yaw, pose.isLocal ? 0.35 : 1);
      actor.avatar.root.rotation.y = actor.yaw;

      // The state travels on the wire; here is where it becomes movement.
      actor.avatar.setAnim(pose.anim ?? 'idle');
      actor.avatar.animator.pin(this.forcedAnim);
      actor.avatar.animate(dt, actor.speed);
    }

    for (const [key, actor] of this.actors) {
      if (seen.has(key)) continue;
      actor.tag?.dispose();
      this.scene?.scene.remove(actor.avatar.root);
      actor.avatar.dispose();
      this.actors.delete(key);
    }
  }

  /**
   * Forces every avatar into one state. For the visual review loop only —
   * `tools/shoot.mjs --anim=dance` has to be able to photograph a pose without
   * a second player and a server.
   */
  forceAnim(state: AnimState | null): void {
    this.forcedAnim = state;
  }

  /** What the compiler measured for each clip, for the review loop. */
  animReport(): ClipReport[] {
    const any = this.actors.values().next().value;
    if (!any) return [];
    return clipReport(any.avatar.rig);
  }

  /** A PNG data URL of the current frame (see Renderer.capture). */
  capture(mime = 'image/png'): string {
    return this.renderer.capture(mime);
  }

  /**
   * Dispara o efeito de um presente sem passar pela economia. Existe para a
   * revisão visual — e SÓ para ela: nada aqui cobra, credita ou pontua PK, e é
   * por isso que o caminho de verdade continua sendo o evento do servidor.
   */
  previewGift(giftId: string, quantity = 1): boolean {
    const gift = GIFT_BY_ID.get(giftId);
    if (!gift || !this.gifts) return false;
    const me = this.actors.get(this.localKey());
    this.gifts.play(
      {
        eventId: `preview_${Date.now()}`,
        senderId: 'preview',
        senderName: 'Preview',
        gifterLevel: 0,
        giftId: gift.id,
        quantity,
        animationId: gift.animationId,
        receiverId: me?.userId ?? '',
        pkPoints: 0,
        timestamp: Date.now(),
      },
      me ? me.avatar.root.position.clone() : new THREE.Vector3(),
    );
    return true;
  }

  /** Debug surface for tools/probe.mjs. */
  stats(): Record<string, unknown> {
    return {
      online: this.online,
      scene: this.sceneId,
      actors: this.actors.size,
      anim: [...this.actors.values()].map((a) => ({
        state: a.avatar.animator.current,
        speed: Math.round(a.speed * 100) / 100,
      })),
      renderer: this.renderer.stats(),
      particles: this.gifts?.activeParticles ?? 0,
      local: this.connection ? this.connection.predictor.stats : { solo: this.solo },
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.offGift?.();
    this.gifts?.dispose();
    this.detachStores?.();
    void this.connection?.leave();
    for (const [, actor] of this.actors) {
      actor.tag?.dispose();
      actor.avatar.dispose();
    }
    this.actors.clear();
    disposeNameTags();
    this.input.dispose();
    this.scene?.dispose();
    this.renderer.dispose();
  }
}

function shortestLerp(from: number, to: number, k: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
}
