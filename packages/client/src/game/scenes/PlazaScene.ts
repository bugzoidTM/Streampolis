import * as THREE from 'three';
import { PLAZA, SCENE_AREA, SCENE_COLLIDERS, type Placement, type SceneId } from '@streampolis/shared';
import { LOOK_DAY, type GradeLook } from '../Renderer.js';
import { GOLDEN_HOUR } from '../Environment.js';
import {
  bakeProps, boxUV, disposeProp, instanceProp, ringSlab, singleProp, xform, type Prop,
} from '../props/Geometry.js';
import { facadeBuilding } from '../props/Buildings.js';
import { VideoWall } from '../props/Screen.js';
import {
  banner, bench, bollard, fountain, kiosk, lampPost, litterBin, planter, shrub, stairRing, tree,
} from '../props/Urban.js';
import { SceneBase } from './GameScene.js';

/**
 * Central Plaza (PRD §6): the square everyone lands in.
 *
 * Every position comes from `PLAZA` in the shared package, which is also what
 * the server's collision table is built from. That is the point: geometry and
 * collision cannot drift, because there is only one set of coordinates.
 *
 * Composition is deliberate rather than scattered — stairs and a fountain
 * anchor the middle, a tree line closes the space at the edge, and perimeter
 * blocks give the horizon something to sit against. Repeated props are
 * instanced and unique ones are baked per material (SPECs §7).
 */
export class PlazaScene extends SceneBase {
  readonly id: SceneId = 'central_plaza';
  /**
   * Daylight, pulled down most of a stop. A plaza is mostly pale stone: at the
   * neutral exposure the pavement clips to white and every material in frame
   * loses its texture at once.
   */
  readonly look: GradeLook = { ...LOOK_DAY, exposure: 0.58, contrast: 1.08, vignette: 0.34 };

  private wall: VideoWall | null = null;
  /** Stamps used only as instancing sources; freed once the scene is built. */
  private stamps: Prop[] = [];

  async build(renderer: THREE.WebGLRenderer): Promise<void> {
    const env = this.makeEnvironment(renderer, {
      ...GOLDEN_HOUR,
      elevation: 27, azimuth: 138,
      // Less fill than the default: the sun has to be able to carve a shadow,
      // and ambient at 0.55 flattens every kerb and step in the scene.
      ambientIntensity: 0.34, envIntensity: 0.78, sunIntensity: 3.0,
      fogNear: 55, fogFar: 260,
    });

    // Collision is not authored here — it is the server's table, read back.
    this.bounds = SCENE_AREA.central_plaza ?? null;
    this.colliders = [...SCENE_COLLIDERS.central_plaza];

    this.buildGround();
    this.buildCentre();
    this.buildFurniture();
    this.buildGreenery();
    this.buildPerimeter();
    this.buildScreen();

    // Spawn ring mirrors the server's spawnFor(): a client that predicts from
    // a different spawn than the server assigned starts life with a snap.
    for (let i = 0; i < 12; i++) {
      const a = i * 2.399963229728653;
      this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * 6, 0, Math.sin(a) * 6));
    }

    this.registerMaterials();
    env.frameShadows(new THREE.Vector3(0, 0, 0), 26);

    for (const stamp of this.stamps) disposeProp(stamp);
    this.stamps = [];
  }

  /** Instances one prop family at the placements the layout dictates. */
  private scatter(stamp: Prop, spots: readonly Placement[], y = 0): void {
    if (spots.length === 0) return;
    const at = spots.map((p) => xform(p.x, y, p.z, p.ry, p.s ?? 1));
    for (const mesh of instanceProp(stamp, at)) this.add(mesh);
    this.stamps.push(stamp);
  }

  private buildGround(): void {
    // Two discs instead of one: the pavement reads as a designed square and the
    // asphalt beyond it keeps the horizon from ending in void under the fog.
    const outer = new THREE.CircleGeometry(120, 8);
    const asphalt = new THREE.Mesh(outer, this.mats.asphalt());
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.position.y = -0.04;
    asphalt.receiveShadow = true;
    this.add(asphalt);

    const paving = new THREE.CircleGeometry(PLAZA.radius + 2.5, 96);
    boxUV(paving, 1.6);
    const floor = new THREE.Mesh(paving, this.mats.paving('#9d968b', '#5d5952'));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.add(floor);

    // Inner apron. Kept close in value to the pavement and finished with a
    // stone kerb: a disc that contrasts reads as a stain on the ground, not as
    // a change of paving.
    const inner = new THREE.CircleGeometry(PLAZA.apron, 72);
    boxUV(inner, 1.05);
    const rosette = new THREE.Mesh(inner, this.mats.paving('#948d83', '#5a564f'));
    rosette.rotation.x = -Math.PI / 2;
    rosette.position.y = 0.012;
    rosette.receiveShadow = true;
    this.add(rosette);

    const kerb = ringSlab(PLAZA.apron, PLAZA.apron + 0.36, 0.06, 96);
    boxUV(kerb, 0.8);
    const kerbMesh = new THREE.Mesh(kerb, this.mats.concrete('#8a847b'));
    kerbMesh.receiveShadow = true;
    kerbMesh.castShadow = true;
    this.add(kerbMesh);
  }

  private buildCentre(): void {
    const steps = stairRing(this.mats, PLAZA.stairInner, PLAZA.stairSteps);
    this.add(singleProp(steps));
    this.stamps.push(steps);

    const water = fountain(this.mats, PLAZA.fountainRadius);
    const basin = singleProp(water);
    basin.position.y = PLAZA.stairSteps * 0.15;
    this.add(basin);
    this.stamps.push(water);
  }

  private buildFurniture(): void {
    this.scatter(bench(this.mats), PLAZA.benches);
    this.scatter(lampPost(this.mats, 4.6), PLAZA.lamps);
    this.scatter(bollard(this.mats), PLAZA.bollards);
    this.scatter(litterBin(this.mats), PLAZA.bins);
    this.scatter(planter(this.mats, 1.6, 1.6, 0.55), PLAZA.planters);
    this.scatter(banner(this.mats, 0.62, 1.9, '#2f6fb8'), PLAZA.banners, 3.0);

    const first = PLAZA.kiosks[0];
    this.scatter(
      kiosk(this.mats, first.width, first.depth),
      PLAZA.kiosks.map((k) => ({ x: k.x, z: k.z, ry: k.ry })),
    );
  }

  private buildGreenery(): void {
    // One instanced draw per canopy variant: three calls for thirty trees.
    for (let variant = 0; variant < 3; variant++) {
      this.scatter(tree(this.mats, variant), PLAZA.trees.filter((t) => t.variant === variant));
    }
    this.scatter(shrub(this.mats, 0.6), PLAZA.shrubs);
  }

  /**
   * Perimeter blocks. Every façade is unique, so instancing would not help —
   * baking them per material turns fourteen buildings into a handful of calls.
   */
  private buildPerimeter(): void {
    const items: Array<{ prop: Prop; matrix: THREE.Matrix4 }> = [];
    const stamps: Prop[] = [];
    const signs = [0xff3d7f, 0x2f7bff, 0xffcc33, 0x39d98a];
    const tints = ['#c9c1b4', '#b6bcc4', '#cfa98d', '#a9b2ad'];

    PLAZA.buildings.forEach((b, i) => {
      const prop = facadeBuilding(this.mats, {
        width: b.width,
        depth: b.depth,
        floors: b.floors,
        style: b.style,
        seed: b.seed,
        signColor: signs[i % signs.length],
        wallTint: tints[i % tints.length],
      });
      stamps.push(prop);
      items.push({ prop, matrix: xform(b.x, 0, b.z, b.ry) });
    });

    const baked = bakeProps(items);
    this.add(singleProp(baked));
    for (const s of stamps) disposeProp(s);
    this.stamps.push(baked);
  }

  /** The plaza's live billboard (PRD §6): the feed, visible from the ground. */
  private buildScreen(): void {
    const s = PLAZA.screen;
    const wall = new VideoWall(this.mats, {
      width: s.width, height: s.height, base: s.base, freestanding: true,
      colors: [0xff3d7f, 0x2f7bff], gain: 2.0,
    });
    wall.group.position.set(s.x, 0, s.z);
    wall.group.rotation.y = s.ry;
    this.add(wall.group);
    this.own(wall);
    this.wall = wall;
  }

  override update(dt: number, camera: THREE.Camera): void {
    super.update(dt, camera);
    this.wall?.update(dt);
  }
}
