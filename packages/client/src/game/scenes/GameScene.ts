import * as THREE from 'three';
import type { SceneId } from '@streampolis/shared';
import type { GradeLook } from '../Renderer.js';
import { Environment, type SkyParams } from '../Environment.js';
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
  build(renderer: THREE.WebGLRenderer): Promise<void>;
  update(dt: number, camera: THREE.Camera): void;
  /** Simple collision: returns the corrected position. */
  clamp(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/** Axis-aligned-in-local-space blocker; `ry` rotates it around Y. */
export interface RectCollider { kind: 'rect'; x: number; z: number; hw: number; hd: number; ry: number }
export interface CircleCollider { kind: 'circle'; x: number; z: number; r: number }
export type Collider = RectCollider | CircleCollider;

/** Walkable limit of a scene. */
export type Bounds =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'rect'; x: number; z: number; hw: number; hd: number };

const PLAYER_RADIUS = 0.28;

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

  protected env: Environment | null = null;
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

  protected makeEnvironment(renderer: THREE.WebGLRenderer, sky: SkyParams) {
    this.env = new Environment(this.scene, renderer, sky);
    return this.env;
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
    const out = to.clone();
    for (let pass = 0; pass < 2; pass++) {
      for (const c of this.colliders) {
        if (c.kind === 'circle') {
          const dx = out.x - c.x, dz = out.z - c.z;
          const d = Math.hypot(dx, dz);
          const min = c.r + PLAYER_RADIUS;
          if (d < min) {
            if (d < 1e-4) { out.x = c.x + min; continue; }
            out.x = c.x + (dx / d) * min;
            out.z = c.z + (dz / d) * min;
          }
        } else {
          const cos = Math.cos(-c.ry), sin = Math.sin(-c.ry);
          const rx = (out.x - c.x) * cos - (out.z - c.z) * sin;
          const rz = (out.x - c.x) * sin + (out.z - c.z) * cos;
          const hw = c.hw + PLAYER_RADIUS, hd = c.hd + PLAYER_RADIUS;
          if (Math.abs(rx) < hw && Math.abs(rz) < hd) {
            const px = hw - Math.abs(rx);
            const pz = hd - Math.abs(rz);
            let nx = rx, nz = rz;
            if (px < pz) nx = Math.sign(rx || 1) * hw;
            else nz = Math.sign(rz || 1) * hd;
            const bc = Math.cos(c.ry), bs = Math.sin(c.ry);
            out.x = c.x + nx * bc - nz * bs;
            out.z = c.z + nx * bs + nz * bc;
          }
        }
      }
    }
    const b = this.bounds;
    if (b) {
      if (b.kind === 'circle') {
        const dx = out.x - b.x, dz = out.z - b.z;
        const d = Math.hypot(dx, dz);
        const max = b.r - PLAYER_RADIUS;
        if (d > max && d > 1e-4) {
          out.x = b.x + (dx / d) * max;
          out.z = b.z + (dz / d) * max;
        }
      } else {
        out.x = THREE.MathUtils.clamp(out.x, b.x - b.hw + PLAYER_RADIUS, b.x + b.hw - PLAYER_RADIUS);
        out.z = THREE.MathUtils.clamp(out.z, b.z - b.hd + PLAYER_RADIUS, b.z + b.hd - PLAYER_RADIUS);
      }
    }
    out.y = to.y;
    return out;
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
