import * as THREE from 'three';
import { resolveCollision, type Area, type Collider, type SceneId } from '@streampolis/shared';
import type { Framing } from '../CameraManager.js';
import type { GradeLook } from '../Renderer.js';
import {
  Environment, InteriorRig, ROOM_DAY,
  type InteriorParams, type LightRig, type SkyParams,
} from '../Environment.js';
import { MatLib } from '../props/Materials.js';

/**
 * A loadable environment. The scene owns its geometry, its lighting rig and
 * its collision, and must be able to give all of it back: switching rooms in
 * Streampolis unloads the previous world entirely (SPECs §9, §12, §46).
 */
export interface GameScene {
  readonly id: SceneId;
  readonly scene: THREE.Scene;
  readonly spawnPoints: THREE.Vector3[];
  readonly look: GradeLook;
  /** How the camera should frame this space. A studio is not a square. */
  readonly framing: Framing;
  /** Longest the camera boom may get here; a small flat cannot afford 9 m. */
  readonly maxBoom: number;
  build(renderer: THREE.WebGLRenderer): Promise<void>;
  update(dt: number, camera: THREE.Camera): void;
  /** Simple collision: returns the corrected position. */
  clamp(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/**
 * Collision types and the solver now live in @streampolis/shared: the server
 * has to reach the same verdict as the scene, and two implementations of
 * "can I stand here" drift the moment one of them is tuned.
 */
export type { Collider, RectCollider, CircleCollider } from '@streampolis/shared';
export type Bounds = Area;

/**
 * Shared plumbing: resource tracking, the collision solver and the lighting
 * rig. Concrete scenes only describe their content.
 */
export abstract class SceneBase implements GameScene {
  abstract readonly id: SceneId;
  abstract readonly look: GradeLook;

  readonly scene = new THREE.Scene();
  readonly spawnPoints: THREE.Vector3[] = [];
  readonly mats = new MatLib();
  readonly framing: Framing = 'room';
  readonly maxBoom: number = 9.0;

  protected env: LightRig | null = null;
  protected colliders: Collider[] = [];
  protected bounds: Bounds | null = null;
  protected elapsed = 0;

  private geometries = new Set<THREE.BufferGeometry>();
  private extraDisposables: Array<{ dispose(): void }> = [];

  abstract build(renderer: THREE.WebGLRenderer): Promise<void>;

  /** Adds a mesh to the scene and takes ownership of its geometry. */
  protected add<T extends THREE.Object3D>(obj: T, parent: THREE.Object3D = this.scene): T {
    parent.add(obj);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) this.geometries.add(m.geometry);
    });
    return obj;
  }

  protected own(d: { dispose(): void }) { this.extraDisposables.push(d); }

  protected makeEnvironment(renderer: THREE.WebGLRenderer, sky: SkyParams): Environment {
    const env = new Environment(this.scene, renderer, sky);
    this.env = env;
    return env;
  }

  /** Indoor rig: no sky, no sun, an IBL baked from the room itself. */
  protected makeInterior(
    renderer: THREE.WebGLRenderer, params: InteriorParams = ROOM_DAY,
  ): InteriorRig {
    const rig = new InteriorRig(this.scene, renderer, params);
    this.env = rig;
    return rig;
  }

  /** Opts every scene material into the cascaded-shadow shader patch. */
  protected registerMaterials() {
    if (!this.env) return;
    for (const m of this.mats.all()) this.env.registerMaterial(m);
  }

  protected blockRect(x: number, z: number, hw: number, hd: number, ry = 0) {
    this.colliders.push({ kind: 'rect', x, z, hw, hd, ry });
  }

  protected blockCircle(x: number, z: number, r: number) {
    this.colliders.push({ kind: 'circle', x, z, r });
  }

  update(dt: number, camera: THREE.Camera) {
    this.elapsed += dt;
    this.env?.update(camera);
  }

  /**
   * Resolves movement against the scene's blockers. Each collider pushes the
   * target out along its shortest escape axis, which for the box-and-cylinder
   * world of the MVP is both stable and cheap enough to run per frame for
   * every visible avatar (SPECs §15).
   */
  clamp(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    const solved = resolveCollision({ x: to.x, z: to.z }, this.colliders, this.bounds);
    return new THREE.Vector3(solved.x, to.y, solved.z);
  }

  dispose() {
    this.env?.dispose();
    this.env = null;
    for (const g of this.geometries) g.dispose();
    this.geometries.clear();
    for (const d of this.extraDisposables) d.dispose();
    this.extraDisposables = [];
    this.mats.dispose();
    this.scene.clear();
  }
}
