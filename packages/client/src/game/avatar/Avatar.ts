import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import { Animator } from '../anim/Animator.js';
import { buildRig, PROPORTION_PRESETS, type BuiltRig, BONE_INDEX } from './Skeleton.js';
import { buildBody, buildHead, paintBody, paintSkin, BODY_PRESETS, FACE_PRESETS } from './BodyBuilder.js';
import { buildFaceStatic, buildFaceRig, type Expression, type FaceRig } from './Face.js';
import { mergeGeometries } from './Loft.js';
import { TOP_BUILDERS, BOTTOM_BUILDERS, SHOE_BUILDERS, ITEM_COLORS, type Builder, type GarmentBuild } from './Wardrobe.js';
import { ACCESSORY_BUILDERS } from './Accessories.js';
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

export interface AvatarOptions {
  /**
   * Constrói o rig de expressão (olho, pálpebra, sobrancelha, lábio). Falso
   * para figurantes: são oito meshes por pessoa que ninguém olha de perto.
   */
  face?: boolean;
  /**
   * Projeta sombra. Falso para figurantes: uma multidão de projetores dobra o
   * passe de sombra por gente que ninguém olha de perto.
   *
   * É OPÇÃO e não um `traverse` de fora porque o corpo v2 nasce vazio e se
   * monta depois — quem apagava a sombra por fora estava varrendo um grupo sem
   * filho nenhum, e a montagem depois acendia tudo de novo.
   */
  castShadow?: boolean;
}

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
  private wantsFace = true;
  private disposables: Array<{ dispose(): void }> = [];

  constructor(config: AvatarConfig, options: AvatarOptions = {}) {
    this.config = { ...config };
    this.wantsFace = options.face !== false;
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
    paintBody(geo, this.rig);
    const mat = makeSkinMaterial(this.config.skinTone);
    // Mesma decisão da cabeça: o zoneamento é cor por vértice. O corpo tem UV
    // em ilhas por membro, então um mapa de pele exigiria um atlas pintado
    // por preset de proporção — e a zona é função da posição, não do desenho.
    mat.vertexColors = true;
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
    paintSkin(geo, this.rig, face);
    const mat = makeSkinMaterial(this.config.skinTone);
    // Só a CABEÇA usa cor por vértice: o corpo é uma malha à parte, com o seu
    // próprio material, e não paga por um atributo que não usa.
    mat.vertexColors = true;
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
    this.face = null;
    // Um figurante a quinze metros não tem expressão que alguém leia, e o rig
    // custa umas oito chamadas de desenho por pessoa. Nariz e orelha continuam
    // lá: eles estão fundidos na cabeça e são de graça.
    if (!this.wantsFace) return;
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

  /**
   * Builds one wardrobe slot. A builder may return several parts, because a
   * varsity jacket's sleeves are not the colour of its body and a shoe's sole
   * is not the colour of its upper — one mesh per material, all bound to the
   * same skeleton, grouped so the slot is still swapped as one thing.
   */
  private buildGarment(slot: 'top' | 'bottom' | 'shoes' | 'accessory', registry: Record<string, Builder>) {
    const id = this.config[slot];
    const builder = registry[id];
    if (!id || !builder) { this.setPart(slot, null); return; }
    const shape = BODY_PRESETS[this.config.bodyPreset % BODY_PRESETS.length];
    const built = builder(this.rig, shape, ITEM_COLORS[id] ?? '#cccccc');
    const parts: GarmentBuild[] = Array.isArray(built) ? built : [built];

    const group = new THREE.Group();
    group.name = slot;
    for (const { geometry, material } of parts) {
      const mesh = new THREE.SkinnedMesh(geometry, material);
      mesh.name = slot;
      mesh.bind(this.rig.skeleton);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      this.disposables.push(material);
    }
    this.setPart(slot, group);
  }

  rebuildWardrobe() {
    this.buildGarment('top', TOP_BUILDERS);
    this.buildGarment('bottom', BOTTOM_BUILDERS);
    this.buildGarment('shoes', SHOE_BUILDERS);
    this.buildGarment('accessory', ACCESSORY_BUILDERS);

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

  get anim(): AnimState {
    return this.animator.current;
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

  /**
   * Prende (ou solta) o piscar. Quem tira RETRATO prende em 0: o retrato
   * adianta o relógio da animação para o corpo ter peso, e nesse adiantamento
   * o reflexo também corre — um card da loja em cada tantos sairia de olho
   * fechado.
   */
  pinBlink(value: number | null) { this.face?.pinBlink(value); }

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

  /**
   * A estatura: do chão ao alto do crânio.
   *
   * Era `Head.y * 1.02` sob um comentário que dizia "altura da coroa". Não era:
   * o osso da cabeça está 19 cm abaixo da coroa, e a coroa é `HeadTop_End`. A
   * placa de nome somava 0,18 a esse valor e acabava POUSADA no cabelo em vez
   * de acima dele — o deslocamento tinha sido escolhido para compensar o erro,
   * e os dois erros juntos davam quase certo.
   */
  get stature(): number {
    return this.rig.restWorld.HeadTop_End.y;
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
