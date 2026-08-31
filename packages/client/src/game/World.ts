import * as THREE from 'three';
import {
  DEFAULT_AVATAR,
  PLAY_AREA,
  applyMoveIntent,
  type AvatarConfig,
  type SceneId,
} from '@streampolis/shared';
import { Renderer } from './Renderer.js';
import { CameraManager } from './CameraManager.js';
import { InputManager } from './InputManager.js';
import { Avatar } from './avatar/Avatar.js';
import { NameTag, disposeNameTags } from './NameTag.js';
import { PlazaScene } from './scenes/PlazaScene.js';
import type { GameScene } from './scenes/GameScene.js';
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
    this.camera.setFraming('room', true);
  }

  get online(): boolean {
    return this.connection !== null;
  }

  async start(): Promise<void> {
    const scene = new PlazaScene();
    await scene.build(this.renderer.webgl);
    this.scene = scene;
    this.renderer.attach(scene.scene, this.camera.camera, scene.look);
    // Snapshot of the static world, taken before any avatar exists. Handing
    // the camera the live scene instead would raycast sprites and skinned
    // meshes every frame — Sprite.raycast needs a camera the boom does not
    // have, and it throws once per frame.
    this.camera.obstacles = [...scene.scene.children];

    if (this.opts.token) {
      try {
        // Only the token travels: identity and appearance are read from it on
        // the server, never sent by the browser (SPECs §36, §68 regra 6).
        const client = new NetworkClient({ token: this.opts.token }, this.opts.endpoint);
        this.connection = await client.joinCity(this.opts.sceneId ?? 'central_plaza');
        this.detachStores = attachStores(this.connection);
      } catch (err) {
        // A dead game server must not blank the screen: fall back to the
        // offline plaza and let the UI say so.
        console.warn('[world] sem servidor, seguindo offline:', err);
        this.connection = null;
      }
    }

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
      this.syncActors(this.connection.poses());
    } else {
      this.stepSolo(dir.x, dir.z, yaw, input.run);
      this.syncActors([this.soloPose()]);
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
      PLAY_AREA[this.opts.sceneId ?? 'central_plaza'],
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
  private syncActors(poses: RenderPose[]): void {
    const seen = new Set<string>();

    for (const pose of poses) {
      seen.add(pose.sessionId);
      let actor = this.actors.get(pose.sessionId);
      if (!actor) {
        const avatar = new Avatar(pose.avatar ?? DEFAULT_AVATAR);
        const tag = new NameTag(pose.name, pose.gifterLevel, avatar.eyeHeight);
        avatar.root.add(tag.sprite);
        this.scene?.scene.add(avatar.root);
        actor = { avatar, tag, yaw: pose.yaw };
        this.actors.set(pose.sessionId, actor);
      }
      actor.avatar.root.position.set(pose.x, pose.y, pose.z);
      // Remote yaw already comes interpolated; this only damps the local
      // avatar's turn, which changes instantly with the input.
      actor.yaw = shortestLerp(actor.yaw, pose.yaw, pose.isLocal ? 0.35 : 1);
      actor.avatar.root.rotation.y = actor.yaw;
    }

    for (const [key, actor] of this.actors) {
      if (seen.has(key)) continue;
      actor.tag.dispose();
      this.scene?.scene.remove(actor.avatar.root);
      actor.avatar.dispose();
      this.actors.delete(key);
    }
  }

  /** Debug surface for tools/probe.mjs. */
  stats(): Record<string, unknown> {
    return {
      online: this.online,
      actors: this.actors.size,
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
