import * as THREE from 'three';
import type { AvatarConfig } from '@streampolis/shared';
import { buildRig, PROPORTION_PRESETS, type BuiltRig, BONE_INDEX } from './Skeleton.js';
import { buildBody, buildHead, BODY_PRESETS, FACE_PRESETS } from './BodyBuilder.js';
import { buildHair, TOP_BUILDERS, BOTTOM_BUILDERS, SHOE_BUILDERS, ITEM_COLORS } from './Wardrobe.js';
import { makeSkinMaterial, makeIrisMaterial, makeScleraMaterial } from './Materials.js';

/**
 * A complete avatar: one skeleton driving a body, a head, eyes and any number
 * of garment meshes. Changing an item rebuilds only that part, so the
 * character creator can preview a swap without regenerating the body.
 */
export class Avatar {
  readonly root = new THREE.Group();
  readonly rig: BuiltRig;
  readonly mixer: THREE.AnimationMixer;

  private config: AvatarConfig;
  private bodyMesh!: THREE.SkinnedMesh;
  private headMesh!: THREE.SkinnedMesh;
  private parts = new Map<string, THREE.Object3D>();
  private eyes: THREE.Group | null = null;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(config: AvatarConfig) {
    this.config = { ...config };
    const proportions = {
      ...PROPORTION_PRESETS[config.bodyPreset % PROPORTION_PRESETS.length],
    };
    proportions.height *= config.height;
    this.rig = buildRig(proportions);

    this.root.add(this.rig.root);
    this.mixer = new THREE.AnimationMixer(this.root);

    this.buildBodyMesh();
    this.buildHeadMesh();
    this.buildEyes();
    this.rebuildWardrobe();
  }

  private bind(mesh: THREE.SkinnedMesh) {
    mesh.add(this.rig.root);
    mesh.bind(this.rig.skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Skinned bounds cannot be derived from the rest pose alone; a generous
    // manual sphere avoids the avatar popping out at the edge of frame.
    mesh.frustumCulled = false;
  }

  private buildBodyMesh() {
    const shape = BODY_PRESETS[this.config.bodyPreset % BODY_PRESETS.length];
    const geo = buildBody(this.rig, shape);
    const mat = makeSkinMaterial(this.config.skinTone);
    this.bodyMesh = new THREE.SkinnedMesh(geo, mat);
    this.bodyMesh.name = 'body';
    this.bind(this.bodyMesh);
    this.root.add(this.bodyMesh);
    this.disposables.push(geo, mat);
  }

  private buildHeadMesh() {
    const face = FACE_PRESETS[this.config.facePreset % FACE_PRESETS.length];
    const geo = buildHead(this.rig, face, BONE_INDEX.Head);
    const mat = makeSkinMaterial(this.config.skinTone);
    this.headMesh = new THREE.SkinnedMesh(geo, mat);
    this.headMesh.name = 'head';
    this.headMesh.bind(this.rig.skeleton);
    this.headMesh.castShadow = true;
    this.headMesh.receiveShadow = true;
    this.headMesh.frustumCulled = false;
    this.root.add(this.headMesh);
    this.disposables.push(geo, mat);
  }

  /**
   * Eyes are parented to the Head bone rather than skinned, which keeps them
   * perfectly rigid inside the socket — skinning an eyeball to a deforming
   * head is what produces the classic "melting eye" artefact.
   */
  private buildEyes() {
    const R = 0.128 * this.rig.proportions.headScale * this.rig.proportions.height;
    const group = new THREE.Group();
    const eyeR = R * 0.135;
    const sclera = makeScleraMaterial();
    const iris = makeIrisMaterial(this.config.facePreset % 6);
    this.disposables.push(sclera, iris);

    for (const side of [-1, 1]) {
      const eye = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(eyeR, 20, 16), sclera);
      eye.add(ball);
      // Iris disc sits on the front of the ball, slightly proud so the
      // clearcoat catches a highlight independent of the sclera.
      const irisMesh = new THREE.Mesh(new THREE.CircleGeometry(eyeR * 0.62, 24), iris);
      irisMesh.position.z = eyeR * 0.86;
      eye.add(irisMesh);
      eye.position.set(side * R * 0.33, R * 0.05, R * 0.60);
      eye.rotation.y = side * -0.07;
      group.add(eye);
      this.disposables.push(ball.geometry, irisMesh.geometry);
    }

    // Positioned in Head-bone local space.
    group.position.set(0, R * 0.42, 0.008);
    this.rig.bones.Head.add(group);
    this.eyes = group;
  }

  private setPart(slot: string, obj: THREE.Object3D | null) {
    const old = this.parts.get(slot);
    if (old) {
      this.root.remove(old);
      old.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      });
      this.parts.delete(slot);
    }
    if (obj) {
      this.parts.set(slot, obj);
      this.root.add(obj);
    }
  }

  private buildGarment(
    slot: 'top' | 'bottom' | 'shoes',
    registry: Record<string, (r: BuiltRig, s: typeof BODY_PRESETS[number], c: string) => { geometry: THREE.BufferGeometry; material: THREE.Material }>,
  ) {
    const id = this.config[slot];
    const builder = registry[id];
    if (!id || !builder) { this.setPart(slot, null); return; }
    const shape = BODY_PRESETS[this.config.bodyPreset % BODY_PRESETS.length];
    const { geometry, material } = builder(this.rig, shape, ITEM_COLORS[id] ?? '#cccccc');
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = slot;
    mesh.bind(this.rig.skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.setPart(slot, mesh);
    this.disposables.push(material);
  }

  rebuildWardrobe() {
    this.buildGarment('top', TOP_BUILDERS);
    this.buildGarment('bottom', BOTTOM_BUILDERS);
    this.buildGarment('shoes', SHOE_BUILDERS);

    const hair = buildHair(this.rig, this.config.hair, this.config.hairColor);
    if (hair) {
      hair.bind(this.rig.skeleton);
      hair.frustumCulled = false;
      this.setPart('hair', hair);
    } else {
      this.setPart('hair', null);
    }
  }

  /** Applies a config change, rebuilding only what actually differs. */
  update(next: Partial<AvatarConfig>) {
    const prev = this.config;
    this.config = { ...prev, ...next };
    const bodyChanged = next.bodyPreset !== undefined && next.bodyPreset !== prev.bodyPreset;
    const skinChanged = next.skinTone !== undefined && next.skinTone !== prev.skinTone;
    const faceChanged = next.facePreset !== undefined && next.facePreset !== prev.facePreset;

    if (bodyChanged) {
      this.root.remove(this.bodyMesh);
      this.bodyMesh.geometry.dispose();
      this.buildBodyMesh();
    } else if (skinChanged) {
      const mat = this.bodyMesh.material as THREE.MeshPhysicalMaterial;
      const fresh = makeSkinMaterial(this.config.skinTone);
      mat.color.copy(fresh.color);
      (this.headMesh.material as THREE.MeshPhysicalMaterial).color.copy(fresh.color);
      fresh.dispose();
    }
    if (faceChanged) {
      this.root.remove(this.headMesh);
      this.headMesh.geometry.dispose();
      this.buildHeadMesh();
    }
    this.rebuildWardrobe();
  }

  get current(): Readonly<AvatarConfig> { return this.config; }

  /** World-space height of the crown, for name tags and camera framing. */
  get eyeHeight(): number {
    return this.rig.restWorld.Head.y * 1.02;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.parts.clear();
    this.eyes = null;
  }
}
