import * as THREE from 'three';
import {
  PLACEABLES, SCENE_AREA, SCENE_COLLIDERS, SCENE_SPAWNS, placementColliders,
  type Fixture, type HomePlacement, type SceneId, type SceneLayout,
} from '@streampolis/shared';
import { makeCameraTransparent, type Framing } from '../CameraManager.js';
import type { GradeLook } from '../Renderer.js';
import type { InteriorParams } from '../Environment.js';
import { bakeProps, disposeProp, singleProp, xform, type Prop } from '../props/Geometry.js';
import type { MatLib } from '../props/Materials.js';
import { buildRoomShell, type ShellStyle } from '../props/Room.js';
import { VideoWall } from '../props/Screen.js';
import {
  armchair, bed, ceilingLamp, coffeeTable, desk, deskChair, deskGear, floorLamp,
  kitchenette, ledStrip, micBoom, monitor, pcTower, potPlant, rug, shelf, sofa,
  stool, tallPlant, trinkets, tvSet, wallArt, wallNeon,
} from '../props/Interior.js';
import {
  barrier, beamMaterial, beamMesh, cameraRig, counter, displayPodium, elevatorDoor,
  floorRing, neonSign, ringLight, speakerStack, spotFixture, stageMark, table, truss,
  trussTower,
} from '../props/Stage.js';
import { SceneBase } from './GameScene.js';
import { AssetLibrary } from '../assets/AssetLibrary.js';
import { FURNITURE_ITEM, FURNITURE_KIND } from '../assets/furnitureKit.js';
import { assetPassEnabled } from '../assets/pass.js';
import type { QualityTier } from '../QualityManager.js';

/**
 * A room, built from its layout.
 *
 * Every interior in Streampolis is the same three things — a shell, a list of
 * fixtures and a lighting rig — so they are one class driven by data rather
 * than six near-copies of a scene file. What each room chooses for itself is
 * its style: the grade, the light, the surfaces and the handful of bespoke
 * touches its subclass adds in `dress()`.
 *
 * Static fixtures are baked together per material, which is what keeps a floor
 * of sixteen workstations at a couple of dozen draw calls (SPECs §7).
 */

export interface InteriorStyle {
  look: GradeLook;
  /** Camera framing; small rooms cannot use the plaza's long boom. */
  framing?: Framing;
  maxBoom?: number;
  lighting: InteriorParams;
  shell(lib: MatLib): ShellStyle;
  /** Default LED colours for screens that do not name one. */
  screen: [number, number];
  /** Visible light cones. Right for a stage, wrong for a living room. */
  beams?: boolean;
  /** Intensity multiplier for practical lamps. */
  practicals?: number;
}

interface Updatable { update(dt: number): void }

/**
 * Which placed props are also light sources, and how much. Practical lamps in
 * a room the player furnishes have to actually light it, or a corner with a
 * lamp in it looks exactly like a corner without one.
 */
const PRACTICAL_LIGHT: Record<string, { color: number; power: number; range: number; height: number }> = {
  floor_lamp:   { color: 0xffe2b8, power: 5.0, range: 5.0, height: 1.45 },
  ceiling_lamp: { color: 0xffe8c8, power: 6.5, range: 7.0, height: 2.30 },
  led_strip:    { color: 0x7c5cff, power: 2.2, range: 3.2, height: 0.05 },
  wall_neon:    { color: 0xff3d9a, power: 2.6, range: 3.4, height: 0.10 },
  tv_set:       { color: 0x2f6fd8, power: 2.4, range: 3.6, height: 0.90 },
};

export class InteriorScene extends SceneBase {
  readonly id: SceneId;
  readonly look: GradeLook;
  override readonly framing: Framing;
  override readonly maxBoom: number;

  protected layout: SceneLayout;
  protected style: InteriorStyle;
  private updatables: Updatable[] = [];
  private placedRoot = new THREE.Group();
  private placedProps: Prop[] = [];
  private placedNodes: THREE.Object3D[] = [];
  /** Modelos do passe; nulo quando o quarto roda procedural. */
  protected lib: AssetLibrary | null = null;

  constructor(id: SceneId, layout: SceneLayout, style: InteriorStyle) {
    super();
    this.id = id;
    this.layout = layout;
    this.style = style;
    this.look = style.look;
    this.framing = style.framing ?? 'default';
    this.maxBoom = style.maxBoom ?? 5.4;
  }

  async build(renderer: THREE.WebGLRenderer, tier: QualityTier = 'high'): Promise<void> {
    // Mesma regra da praça: no tier baixo o quarto continua procedural. A
    // diferença é que aqui a conta é barata — um quarto tem duas dúzias de
    // móveis, não trinta árvores — então o corte é só no tier mais baixo.
    if (assetPassEnabled() && tier !== 'low') {
      const lib = await AssetLibrary.load(['furniture']);
      this.lib = lib.has('furniture') ? lib : null;
      if (this.lib) this.own(lib); else lib.dispose();
    }

    this.makeInterior(renderer, this.style.lighting);

    // Collision comes from the shared table, which is built from the same
    // layout this scene is drawing. Authoring it twice is how a player ends up
    // walking through a wall on one machine and into it on another.
    this.bounds = SCENE_AREA[this.id] ?? null;
    this.colliders = [...SCENE_COLLIDERS[this.id]];

    const shell = buildRoomShell(this.mats, this.layout.shell, this.style.shell(this.mats));
    this.add(shell.group);
    for (const d of shell.disposables) this.own(d);

    this.buildFixtures();
    this.placedRoot.name = 'placed';
    this.add(this.placedRoot);
    this.dress();

    for (const s of SCENE_SPAWNS[this.id]) {
      this.spawnPoints.push(new THREE.Vector3(s.x, 0, s.z));
    }
    this.registerMaterials();
    for (const mat of this.lib?.materials() ?? []) this.env?.registerMaterial(mat);
  }

  /** Hook for the bespoke touches a specific room needs. */
  protected dress(): void {}

  /**
   * The furniture the OWNER put here, as opposed to the layout's own fixtures.
   *
   * Deliberately not baked: build mode moves these one at a time, and a bake
   * would have to be torn down and rebuilt on every drag. A room holds a few
   * dozen of them, which is a few dozen draw calls — the right trade for
   * something the player edits live.
   */
  setPlacements(list: readonly HomePlacement[]): void {
    for (const p of this.placedProps) disposeProp(p);
    this.placedProps = [];
    this.placedRoot.clear();
    this.placedNodes = [];

    for (const p of list) {
      const def = PLACEABLES[p.itemId];
      if (!def) continue;
      const f: Fixture = {
        kind: def.kind, item: p.itemId, x: p.x, z: p.z, ry: (p.turn * Math.PI) / 2, y: def.y ?? 0,
        w: def.w, h: def.h, d: def.d, tint: def.tint, color: def.color,
        hw: def.hw, hd: def.hd,
      };
      const prop = this.staticProp(f, (_k, make) => make());
      if (!prop) continue;
      this.placedProps.push(prop);

      const node = singleProp(prop);
      node.applyMatrix4(xform(f.x, f.y ?? 0, f.z, f.ry ?? 0, 1));
      node.userData.placementIndex = this.placedNodes.length;
      this.placedRoot.add(node);
      this.placedNodes.push(node);

      // A lamp that emits nothing is furniture-shaped, not a lamp.
      const glow = PRACTICAL_LIGHT[def.kind];
      if (glow) {
        const light = new THREE.PointLight(glow.color, glow.power * (this.style.practicals ?? 1), glow.range, 2);
        light.position.set(f.x, (f.y ?? 0) + glow.height, f.z);
        this.placedRoot.add(light);
      }
    }

    // Walk-through items stay walk-through; the rest join the collider table
    // so a sofa you placed is a sofa you bump into. A conta é de `shared`: o
    // servidor e o preditor do cliente fazem a MESMA a partir da mesma lista, e
    // a versão que morava aqui era a única que existia — o resultado é que só
    // o modo offline sabia da mobília do jogador.
    this.colliders = [...SCENE_COLLIDERS[this.id], ...placementColliders(list)];
  }

  /** World-space nodes of the placed furniture, for build-mode picking. */
  get placementNodes(): readonly THREE.Object3D[] { return this.placedNodes; }

  protected track(u: Updatable): void { this.updatables.push(u); }

  private buildFixtures(): void {
    const stamps = new Map<string, Prop>();
    const items: Array<{ prop: Prop; matrix: THREE.Matrix4 }> = [];

    const stamp = (key: string, make: () => Prop): Prop => {
      let hit = stamps.get(key);
      if (!hit) { hit = make(); stamps.set(key, hit); }
      return hit;
    };

    for (const f of this.layout.fixtures) {
      const at = xform(f.x, f.y ?? 0, f.z, f.ry ?? 0, f.s ?? 1);
      const prop = this.staticProp(f, stamp);
      if (prop) items.push({ prop, matrix: at });
      this.dynamicPart(f);
    }

    if (items.length) {
      const baked = bakeProps(items);
      this.add(singleProp(baked));
      // The bake owns copies; the stamps were only ever sources.
      for (const [, p] of stamps) disposeProp(p);
    }
  }

  /** The part of a fixture that is just geometry, and can be baked. */
  private staticProp(f: Fixture, stamp: (k: string, m: () => Prop) => Prop): Prop | null {
    const lib = this.mats;
    const key = `${f.kind}|${f.w ?? ''}|${f.h ?? ''}|${f.d ?? ''}|${f.tint ?? ''}|${f.color ?? ''}`;

    // Um `kind` da tabela do passe é desenhado pelo modelo; o resto continua
    // procedural. O alvo em metros vem do PRÓPRIO fixture, que é o mesmo
    // número que o servidor usa como bloqueador — o móvel não pode ser maior
    // do que aquilo em que se esbarra.
    // Por ITEM primeiro, por `kind` depois. O pacote traz duas poltronas, dois
    // sofás e três tapetes; usá-los é o que devolve, sem cor por item, a
    // diferença entre `fur_sofa_01` e `fur_sofa_02` — os dois modelos do
    // KayKit compartilham um atlas único, então tingir um deles tingiria os
    // dois e mais vinte móveis junto.
    const modelled = this.lib
      ? (f.item ? FURNITURE_ITEM[f.item] : undefined) ?? FURNITURE_KIND[f.kind]
      : null;
    if (modelled) {
      const target = {
        w: f.w ?? (f.hw !== undefined ? f.hw * 2 : undefined),
        h: f.h,
        d: f.d ?? (f.hd !== undefined ? f.hd * 2 : undefined),
      };
      const prop = this.lib!.fitted('furniture', modelled.id, target, modelled.fit);
      if (prop) return prop;
    }

    switch (f.kind) {
      case 'sofa': return stamp(key, () => sofa(lib, f.w ?? 1.92, f.tint ?? '#4a5a78'));
      case 'armchair': return stamp(key, () => armchair(lib, f.tint ?? '#7a5c8a'));
      case 'stool': return stamp(key, () => stool(lib, f.h ?? 0.62));
      case 'desk_chair': return stamp(key, () => deskChair(lib));
      case 'coffee_table': return stamp(key, () => coffeeTable(lib, f.w ?? 1.1, f.d ?? 0.6));
      case 'desk': return stamp(key, () => desk(lib, f.w ?? 1.4, f.d ?? 0.68));
      case 'table': return stamp(key, () => table(lib, f.w ?? 3.2, f.d ?? 1.8));
      case 'shelf': return stamp(key, () => shelf(lib, f.w ?? 1.2, f.h ?? 1.9));
      case 'kitchenette': return stamp(key, () => kitchenette(lib, f.w ?? 2.4));
      case 'counter': return stamp(key, () => counter(lib, f.w ?? 3.2, f.color ?? 0x2fd8ff));
      case 'bed': return stamp(key, () => bed(lib, f.w ?? 1.4, f.d ?? 2.0));
      case 'rug': return stamp(key, () => rug(lib, f.w ?? 1.8, f.d ?? 1.2, f.tint ?? '#8a6f62'));
      case 'pot_plant': return stamp(key, () => potPlant(lib, 1));
      case 'plant_tall': return stamp(key, () => tallPlant(lib, f.h ?? 1.35));
      case 'tv_set': return stamp(key, () => tvSet(lib, f.w ?? 1.15, f.h ?? 0.66));
      case 'pc_tower': return stamp(key, () => pcTower(lib));
      case 'mic_boom': return stamp(key, () => micBoom(lib));
      case 'led_strip': return stamp(key, () => ledStrip(lib, f.w ?? 1.6, f.color ?? 0x7c5cff));
      case 'trinkets': return stamp(key, () => trinkets(lib, 7));
      case 'floor_lamp': return stamp(key, () => floorLamp(lib, f.h ?? 1.55));
      case 'ceiling_lamp': return stamp(key, () => ceilingLamp(lib, 0.5));
      case 'wall_art': return stamp(key, () => wallArt(lib, f.w ?? 0.7, f.h ?? 0.9, f.color ?? 0x8ea9c4));
      case 'wall_neon': return stamp(key, () => wallNeon(lib, f.color ?? 0xff3d9a));
      case 'neon_sign': return stamp(key, () => neonSign(lib, f.color ?? 0xff3d9a, f.w ?? 1.6, f.h ?? 0.6));
      case 'monitor': return stamp(key, () => monitor(lib, f.w ?? 0.62, f.h ?? 0.36));
      case 'desk_gear': return stamp(key, () => deskGear(lib));
      case 'ring_light': return stamp(key, () => ringLight(lib));
      case 'camera_rig': return stamp(key, () => cameraRig(lib));
      case 'truss': return stamp(key, () => truss(lib, f.w ?? 8));
      case 'tower': return stamp(key, () => trussTower(lib, f.h ?? 8));
      case 'speaker_stack': return stamp(key, () => speakerStack(lib, f.h ?? 2.2));
      case 'barrier': return stamp(key, () => barrier(lib, f.w ?? 2.2));
      case 'elevator': return stamp(key, () => elevatorDoor(lib, f.w ?? 2.6));
      case 'display': return stamp(key, () => displayPodium(lib, f.r ?? 0.6, f.color ?? 0x2fd8ff));
      case 'stage_mark': return stamp(key, () => stageMark(lib, f.w ?? 4, f.d ?? 2.4, f.color ?? 0xff3d7f));
      case 'centre_ring': return stamp(key, () => floorRing(lib, (f.w ?? 6) / 2, f.color ?? 0xffcc33));
      case 'spot': {
        const aim = this.aimVector(f);
        return stamp(`${key}|${aim.x.toFixed(2)}|${aim.y.toFixed(2)}|${aim.z.toFixed(2)}`,
          () => spotFixture(lib, f.color ?? 0xfff0dc, aim));
      }
      default: return null;
    }
  }

  /** Lights, screens and anything else that is not a static triangle. */
  private dynamicPart(f: Fixture): void {
    const gain = this.style.practicals ?? 1;
    switch (f.kind) {
      case 'led_wall':
      case 'tv': {
        const [a, b] = this.style.screen;
        const wall = new VideoWall(this.mats, {
          width: f.w ?? 4, height: f.h ?? 2.4, base: f.y ?? 1,
          // Gain is deliberately modest: a wall of LED that clips to white
          // takes the whole frame with it once the bloom pass sees it.
          colors: [f.color ?? a, b], gain: f.kind === 'tv' ? 1.05 : 1.35,
          bars: f.kind !== 'tv',
        });
        wall.group.position.set(f.x, 0, f.z);
        wall.group.rotation.y = f.ry ?? 0;
        this.add(wall.group);
        this.own(wall);
        this.track(wall);
        // A wall of LED is the brightest thing in the room; it has to spill.
        const spill = new THREE.PointLight(f.color ?? a, 3.2 * gain, (f.w ?? 4) * 1.5, 2);
        spill.position.set(
          f.x + Math.sin(f.ry ?? 0) * 1.2,
          (f.y ?? 1) + (f.h ?? 2.4) / 2,
          f.z + Math.cos(f.ry ?? 0) * 1.2,
        );
        this.add(spill);
        break;
      }
      case 'ceiling_lamp': {
        const lamp = new THREE.PointLight(0xffe8c8, 7 * gain, 9, 2);
        lamp.position.set(f.x, (f.y ?? 2.8) - 0.66, f.z);
        this.add(lamp);
        break;
      }
      case 'floor_lamp': {
        const lamp = new THREE.PointLight(0xffe0b0, 5 * gain, 7, 2);
        lamp.position.set(f.x, (f.h ?? 1.55) + 0.02, f.z);
        this.add(lamp);
        break;
      }
      case 'ring_light': {
        const lamp = new THREE.PointLight(0xfff2dc, 6 * gain, 6, 2);
        lamp.position.set(f.x, 1.62, f.z);
        this.add(lamp);
        break;
      }
      case 'spot': {
        const from = new THREE.Vector3(f.x, f.y ?? 3.6, f.z);
        const target = new THREE.Vector3(...(f.aim ?? [f.x, 0, f.z]));
        const distance = from.distanceTo(target);
        const light = new THREE.SpotLight(
          f.color ?? 0xfff0dc,
          // Inverse-square falloff means the intensity a stage lamp needs
          // scales with the square of how far it hangs above the floor.
          2.6 * distance * distance * gain,
          distance * 2.4,
          0.34,
          0.55,
          2,
        );
        light.position.copy(from);
        light.target.position.copy(target);
        this.add(light);
        this.add(light.target);
        if (this.style.beams) {
          const mat = beamMaterial(f.color ?? 0xfff0dc, 0.26);
          this.own(mat);
          this.add(makeCameraTransparent(beamMesh(mat, from, target, 0.3)));
        }
        break;
      }
      case 'display': {
        const glow = new THREE.PointLight(f.color ?? 0x2fd8ff, 2.2 * gain, 3.4, 2);
        glow.position.set(f.x, 1.15, f.z);
        this.add(glow);
        break;
      }
      default: break;
    }
  }

  private aimVector(f: Fixture): THREE.Vector3 {
    const aim = f.aim ?? [f.x, 0, f.z];
    return new THREE.Vector3(aim[0] - f.x, aim[1] - (f.y ?? 3.6), aim[2] - f.z);
  }

  override update(dt: number, camera: THREE.Camera): void {
    super.update(dt, camera);
    for (const u of this.updatables) u.update(dt);
  }

  override dispose(): void {
    this.updatables = [];
    super.dispose();
  }
}
