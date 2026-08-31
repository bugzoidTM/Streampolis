import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import { Animator } from '../anim/Animator.js';
import { buildRig, PROPORTION_PRESETS, type BuiltRig, BONE_INDEX } from './Skeleton.js';
import { buildBody, buildHead, BODY_PRESETS, FACE_PRESETS } from './BodyBuilder.js';
import { buildFaceStatic, buildFaceRig, type Expression, type FaceRig } from './Face.js';
import { mergeGeometries } from './Loft.js';
import { TOP_BUILDERS, BOTTOM_BUILDERS, SHOE_BUILDERS, ITEM_COLORS } from './Wardrobe.js';
import { buildHair } from './Hair.js';
import { makeSkinMaterial, EYE_COLORS } from './Materials.js';

/**
 * Which face goes with which action. Deliberately blunt: the world reports
 * movement, not mood, and guessing one from the other beats a host who wins a
 * PK with the same expression they had while standing still.
 */
const EXPRESSION_FOR_ANIM: Partial<Record<AnimState, Expression>> = {
  wave: 'smile',
  dance: 'smile',
  clap: 'smile',
  pkWin: 'smile',
  pkLose: 'focus',
  giftReact: 'surprise',
  celebrate: 'surprise',
};

/**
 * A complete avatar: one skeleton driving a body, a head, eyes and any number
 * of garment meshes. Changing an item rebuilds only that part, so the
 * character creator can preview a swap without regenerating the body.
 */
export class Avatar {
  readonly root = new THREE.Group();
  readonly rig: BuiltRig;
  /** State machine + mixer. Every avatar animates through this and only this. */
  readonly animator: Animator;

  private config: AvatarConfig;
  private bodyMesh!: THREE.SkinnedMesh;
  private headMesh!: THREE.SkinnedMesh;
  private parts = new Map<string, THREE.Object3D>();
  private face: FaceRig | null = null;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(config: AvatarConfig) {
    this.config = { ...config };
    const proportions = {
      ...PROPORTION_PRESETS[config.bodyPreset % PROPORTION_PRESETS.length],
    };
    proportions.height *= config.height;
    this.rig = buildRig(proportions);

    this.root.add(this.rig.root);
    this.animator = new Animator(this.root, this.rig);

    this.buildBodyMesh();
    this.buildHeadMesh();
    this.buildFace();
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
    // Nose and ears never move, so they ride inside the head's own geometry:
    // no extra draw call, and no chance of a feature drifting off the skull.
    const geo = mergeGeometries([buildHead(this.rig, face, BONE_INDEX.Head), buildFaceStatic(this.rig, face)]);
    geo.computeVertexNormals();
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
   * The expression rig hangs off the Head bone rather than being skinned:
   * skinning an eyeball to a deforming head is what produces the classic
   * "melting eye", and a brow that follows the skull's vertices cannot be
   * raised without dragging the forehead with it.
   */
  private buildFace() {
    this.face?.dispose();
    const shape = FACE_PRESETS[this.config.facePreset % FACE_PRESETS.length];
    this.face = buildFaceRig(this.rig, shape, {
      skinTone: this.config.skinTone,
      hairColor: this.config.hairColor,
      eyeColor: this.config.facePreset % EYE_COLORS.length,
    });
    this.rig.bones.Head.add(this.face.group);
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

    const hair = buildHair(
      this.rig,
      FACE_PRESETS[this.config.facePreset % FACE_PRESETS.length],
      this.config.hair,
      this.config.hairColor,
    );
    if (hair) {
      hair.bind(this.rig.skeleton);
      hair.frustumCulled = false;
      this.setPart('hair', hair);
    } else {
      this.setPart('hair', null);
    }
  }

  /** What the world says this avatar is doing right now. */
  setAnim(state: AnimState) {
    this.animator.request(state);
    // A body that dances with a blank face reads as a mannequin on a turntable.
    // The world only ever says what the avatar is DOING; the face is inferred.
    this.setExpression(EXPRESSION_FOR_ANIM[state] ?? 'neutral');
  }

  /** Overrides the face for a beat — a gift landing, a PK swinging. */
  setExpression(e: Expression) { this.face?.setExpression(e); }

  get expression(): Expression { return this.face?.current ?? 'neutral'; }

  /**
   * Advances the animation. `speed` is the ground speed the renderer is about
   * to draw, in m/s, which is what the locomotion clips are timed against.
   */
  animate(dt: number, speed: number) {
    this.animator.update(dt, speed);
    this.face?.update(dt);
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
    if (faceChanged || skinChanged) {
      if (faceChanged) {
        this.root.remove(this.headMesh);
        this.headMesh.geometry.dispose();
        this.buildHeadMesh();
      }
      // Lips and lids are tinted from the skin tone, so a tone change has to
      // rebuild them even when the face preset did not move.
      if (this.face) this.rig.bones.Head.remove(this.face.group);
      const keep = this.face?.current ?? 'neutral';
      this.buildFace();
      this.face?.setExpression(keep);
    }
    this.rebuildWardrobe();
  }

  get current(): Readonly<AvatarConfig> { return this.config; }

  /** World-space height of the crown, for name tags and camera framing. */
  get eyeHeight(): number {
    return this.rig.restWorld.Head.y * 1.02;
  }

  dispose() {
    this.animator.dispose();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.face?.dispose();
    this.face = null;
    this.disposables = [];
    this.parts.clear();
  }
}
