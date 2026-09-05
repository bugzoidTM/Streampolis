import * as THREE from 'three';
import type { MouthState } from './MouthV2.js';

export const FACIAL_KEYS = ['smile', 'sad', 'surprise', 'mouthOpen'] as const;
export type FacialKey = typeof FACIAL_KEYS[number];
export type FacialDriver = 'expressions' | 'animation';

interface Binding {
  mesh: THREE.SkinnedMesh;
  indices: number[];
  initial: number[];
}

function tagged(mesh: THREE.SkinnedMesh): boolean {
  const tag = mesh.userData.streampolisFacial ?? mesh.geometry.userData.streampolisFacial
    ?? mesh.parent?.userData.streampolisFacial;
  return tag?.version === 1 && tag?.mouth === 'integrated' && tag?.region === 'lowerFace';
}

/**
 * Opt-in support for authored lower-face geometry. Current wardrobe heads do
 * not carry this contract and therefore keep FaceV2/MouthV2 unchanged.
 * No vertices, materials, skin attributes, bone transforms or binds are edited.
 */
export class FacialMorphs {
  private readonly bindings: Binding[];
  private readonly weights = [0, 0, 0, 0];
  private driver: FacialDriver = 'expressions';
  private expression: MouthState = 'neutral';
  private speechDuration = 0;
  private speechTime = 0;
  private speechSeed = 0;
  private disposed = false;

  /** Invalid/incomplete heads return null: the caller retains the old face. */
  static create(meshes: readonly THREE.SkinnedMesh[]): FacialMorphs | null {
    const bindings: Binding[] = [];
    const useful = [false, false, false, false];
    for (const mesh of new Set(meshes)) {
      if (!tagged(mesh)) continue;
      const positions = mesh.geometry.getAttribute('position');
      const targets = mesh.geometry.morphAttributes.position;
      const dictionary = mesh.morphTargetDictionary;
      const influences = mesh.morphTargetInfluences;
      if (!positions || positions.itemSize !== 3 || !targets || !dictionary || !influences) return null;
      const indices = FACIAL_KEYS.map((key) => dictionary[key]);
      if (new Set(indices).size !== 4 || indices.some((index) => !Number.isInteger(index)
        || index < 0 || index >= targets.length || index >= influences.length)) return null;
      const box = new THREE.Box3().setFromBufferAttribute(positions as THREE.BufferAttribute);
      const extent = box.getSize(new THREE.Vector3()).length();
      if (!Number.isFinite(extent) || extent <= 0) return null;
      const maxDeltaSquared = (extent * 0.35) ** 2;
      for (let k = 0; k < indices.length; k++) {
        const index = indices[k];
        const target = targets[index];
        const normal = mesh.geometry.morphAttributes.normal?.[index];
        if (!target || target.itemSize !== 3 || target.count !== positions.count
          || !Number.isFinite(influences[index]) || influences[index] < 0 || influences[index] > 1
          || (normal && (normal.itemSize !== 3 || normal.count !== positions.count))) return null;
        for (let v = 0; v < target.count; v++) {
          const base = [positions.getX(v), positions.getY(v), positions.getZ(v)];
          const value = [target.getX(v), target.getY(v), target.getZ(v)];
          if (!base.every(Number.isFinite) || !value.every(Number.isFinite)) return null;
          if (normal && ![normal.getX(v), normal.getY(v), normal.getZ(v)].every(Number.isFinite)) return null;
          let deltaSquared = 0;
          for (let axis = 0; axis < 3; axis++) {
            const delta = value[axis] - (mesh.geometry.morphTargetsRelative ? 0 : base[axis]);
            deltaSquared += delta * delta;
          }
          if (deltaSquared > maxDeltaSquared) return null;
          if (deltaSquared > extent * extent * 1e-12) useful[k] = true;
        }
      }
      bindings.push({ mesh, indices, initial: indices.map((index) => influences[index]) });
    }
    // Four names with zero deltas are placeholders, not an integrated face.
    return bindings.length && useful.every(Boolean) ? new FacialMorphs(bindings) : null;
  }

  private constructor(bindings: Binding[]) {
    this.bindings = bindings;
    for (const binding of bindings) {
      // A clone may share geometry, never expression weights with another head.
      binding.mesh.morphTargetInfluences = [...binding.mesh.morphTargetInfluences!];
    }
    for (let i = 0; i < 4; i++) this.weights[i] = bindings[0].initial[i];
  }

  setState(state: MouthState): void { this.expression = state; }
  get state(): MouthState { return this.expression; }

  /**
   * Exactly one owner writes these four targets. Set animation before starting
   * a facial AnimationAction; stop/fade that action before returning control.
   */
  setDriver(driver: FacialDriver): void {
    if (this.disposed || this.driver === driver) return;
    this.driver = driver;
    if (driver === 'animation') {
      this.restore();
      this.speechDuration = 0;
    } else {
      const first = this.bindings[0];
      for (let i = 0; i < 4; i++) {
        const value = first.mesh.morphTargetInfluences![first.indices[i]];
        this.weights[i] = Number.isFinite(value) ? THREE.MathUtils.clamp(value, 0, 1) : 0;
      }
    }
  }

  speak(seconds: number, seed = 0): void {
    this.speechDuration = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    this.speechTime = 0;
    this.speechSeed = Number.isFinite(seed) ? seed : 0;
  }

  get speaking(): boolean {
    return !this.disposed && this.driver === 'expressions' && this.speechTime < this.speechDuration;
  }

  /** Call after AnimationMixer.update; animation mode makes this a no-op. */
  update(dt: number): void {
    if (this.disposed || this.driver !== 'expressions' || !Number.isFinite(dt) || dt < 0) return;
    this.speechTime += dt;
    const damping = 1 - Math.exp(-dt / 0.12);
    let speech = 0;
    if (this.speaking) {
      const envelope = Math.min(1, this.speechTime / 0.12, (this.speechDuration - this.speechTime) / 0.12);
      const syllable = 0.5 - 0.5 * Math.cos(this.speechTime * Math.PI * 2 * 4.8 + this.speechSeed);
      speech = 0.55 * envelope * syllable;
    }
    for (let i = 0; i < 4; i++) {
      const target = i === 3 ? speech : FACIAL_KEYS[i] === this.expression ? 1 : 0;
      this.weights[i] += (target - this.weights[i]) * damping;
      if (Math.abs(target - this.weights[i]) < 1e-5) this.weights[i] = target;
    }
    for (const { mesh, indices } of this.bindings) {
      for (let i = 0; i < 4; i++) mesh.morphTargetInfluences![indices[i]] = this.weights[i];
    }
  }

  describe(): Record<string, unknown> {
    return {
      source: 'authored-morphs', driver: this.driver, state: this.expression,
      meshes: this.bindings.length, targets: [...FACIAL_KEYS], speaking: this.speaking,
    };
  }

  private restore(): void {
    for (const { mesh, indices, initial } of this.bindings) {
      for (let i = 0; i < 4; i++) mesh.morphTargetInfluences![indices[i]] = initial[i];
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.restore();
    this.disposed = true;
  }
}
