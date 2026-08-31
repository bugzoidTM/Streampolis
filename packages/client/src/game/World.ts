import * as THREE from 'three';
import {
  DEFAULT_AVATAR,
  PLAY_AREA,
  applyMoveIntent,
  type AnimState,
  type AvatarConfig,
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
import { NetworkClient } from '../network/NetworkClient.js';
import type { WorldConnection } from '../network/WorldConnection.js';
import type { RenderPose } from '../network/types.js';
import { attachStores } from '../network/bridge.js';

export interface WorldOptions {
  canvas: HTMLCanvasElement;
  sceneId?: SceneId;
  tier?: 'low' | 'medium' | 'high';
  /** Look used only in offline mode; online it comes signed in the token. */
  avatar?: AvatarConfig;
  displayName?: string;
  /** Auth token. Absent means offline: the plaza runs with no server at all. */
  token?: string;
  endpoint?: string;
}

interface Actor {
  avatar: Avatar;
  tag: NameTag;
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
  private sceneId: SceneId = 'central_plaza';
  /** The boom starts behind the avatar, once, on the first pose it sees. */
  private cameraAligned = false;
  /** Debug override from the screenshot tool; never set during play. */
  private forcedAnim: AnimState | null = null;
  private connection: WorldConnection | null = null;
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
    this.sceneId = this.opts.sceneId ?? 'central_plaza';

    // Connect BEFORE building the scene: which room the player is in is the
    // server's answer, not the query string's. Building first and asking later
    // is how a live ends up being played inside the plaza.
    if (this.opts.token) {
      try {
        // Only the token travels: identity and appearance are read from it on
        // the server, never sent by the browser (SPECs §36, §68 regra 6).
        const client = new NetworkClient({ token: this.opts.token }, this.opts.endpoint);
        this.connection = await client.joinCity(this.sceneId);
        this.detachStores = attachStores(this.connection);
        this.sceneId = this.connection.state?.sceneId ?? this.sceneId;
      } catch (err) {
        // A dead game server must not blank the screen: fall back to the
        // offline scene and let the UI say so.
        console.warn('[world] sem servidor, seguindo offline:', err);
        this.connection = null;
      }
    }

    const scene = createScene(this.sceneId);
    await scene.build(this.renderer.webgl);
    this.scene = scene;
    this.renderer.attach(scene.scene, this.camera.camera, scene.look);
    // The scene decides how it is framed: a 7-metre studio photographed with
    // the plaza's boom puts the camera in the neighbours' flat.
    this.camera.setFraming(scene.framing, true);
    this.camera.setLimits({ maxDistance: scene.maxBoom });
    // Snapshot of the static world, taken before any avatar exists. Handing
    // the camera the live scene instead would raycast sprites and skinned
    // meshes every frame — Sprite.raycast needs a camera the boom does not
    // have, and it throws once per frame.
    this.camera.obstacles = [...scene.scene.children];

    if (!this.connection) {
      const spawn = scene.spawnPoints[0] ?? new THREE.Vector3(0, 0, 6);
      this.solo = { x: spawn.x, z: spawn.z, yaw: Math.atan2(-spawn.x, -spawn.z), moving: false };
    }

    this.resize();
    this.loop();
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
        const tag = new NameTag(pose.name, pose.gifterLevel, avatar.eyeHeight);
        avatar.root.add(tag.sprite);
        this.scene?.scene.add(avatar.root);
        actor = {
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
        // Behind the player, looking where they look. Leaving the boom at yaw 0
        // put the camera between the host and the LED wall in every live room.
        this.camera.yaw = pose.yaw + Math.PI;
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
      actor.tag.dispose();
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
      local: this.connection ? this.connection.predictor.stats : { solo: this.solo },
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.detachStores?.();
    void this.connection?.leave();
    for (const [, actor] of this.actors) {
      actor.tag.dispose();
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
