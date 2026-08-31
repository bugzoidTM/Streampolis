import * as THREE from 'three';
import {
  PLACEABLES, placementFits, placementsOverlap,
  type HomePlacement, type RoomBounds,
} from '@streampolis/shared';
import type { InteriorScene } from './scenes/InteriorScene.js';

/**
 * Build Mode Lite.
 *
 * Place, move, rotate, store. No walls, no floors, no stacking rules — the
 * loop this exists to close is "earned Credits → bought a sofa → put it in my
 * place → a friend came over and saw it", and none of the rest of a house
 * editor is on that path.
 *
 * The grid is 25 cm and rotation is in quarter turns, on purpose. Free
 * placement looks worse, not better: furniture at 3.7° to the wall reads as a
 * mistake in every screenshot a player ever takes of their own room.
 *
 * Authority stays with the API (SPECs §68): this proposes a layout, the server
 * checks ownership, bounds and overlap and answers. The same two functions do
 * the checking on both sides, so what is greyed out here is what is refused
 * there — one arithmetic, not two.
 */

export const GRID_STEP = 0.25;

export interface BuildModeOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  scene: InteriorScene;
  bounds: RoomBounds;
  /** Fired whenever the layout changes, including mid-drag. */
  onChange: (list: HomePlacement[], selected: number) => void;
}

const snap = (v: number) => Math.round(v / GRID_STEP) * GRID_STEP;

export class BuildMode {
  private opts: BuildModeOptions;
  private list: HomePlacement[] = [];
  private selected = -1;
  private dragging = false;
  private enabled = false;
  private ray = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private pointer = new THREE.Vector2();
  private hit = new THREE.Vector3();
  /** Where the drag started, so an illegal drop can be undone. */
  private origin: HomePlacement | null = null;

  constructor(opts: BuildModeOptions) {
    this.opts = opts;
  }

  get placements(): readonly HomePlacement[] { return this.list; }
  get selectedIndex(): number { return this.selected; }
  get active(): boolean { return this.enabled; }

  load(list: readonly HomePlacement[]): void {
    this.list = list.map((p) => ({ ...p }));
    this.selected = -1;
    this.apply();
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    const c = this.opts.canvas;
    c.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.dragging = false;
    this.selected = -1;
    const c = this.opts.canvas;
    c.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    this.apply();
  }

  /** Puts one item in the middle of the room and selects it. */
  add(itemId: string): boolean {
    if (!PLACEABLES[itemId]) return false;
    // Spiral outward from the centre until a legal spot turns up, so adding a
    // second sofa does not silently land inside the first.
    for (let ring = 0; ring < 12; ring++) {
      for (let i = 0; i < Math.max(1, ring * 8); i++) {
        const a = (i / Math.max(1, ring * 8)) * Math.PI * 2;
        const candidate: HomePlacement = {
          itemId,
          x: snap(Math.cos(a) * ring * GRID_STEP * 2),
          z: snap(Math.sin(a) * ring * GRID_STEP * 2),
          turn: 0,
        };
        if (this.legal(candidate, -1)) {
          this.list.push(candidate);
          this.selected = this.list.length - 1;
          this.apply();
          return true;
        }
      }
    }
    return false;
  }

  /** Back to the wardrobe. The item stays owned; it is just not out. */
  store(index = this.selected): void {
    if (index < 0 || index >= this.list.length) return;
    this.list.splice(index, 1);
    this.selected = -1;
    this.apply();
  }

  rotate(index = this.selected, by = 1): void {
    const item = this.list[index];
    if (!item) return;
    const turned = { ...item, turn: (((item.turn + by) % 4) + 4) % 4 };
    // A rotation that puts a long sofa through a wall is refused, not clamped:
    // silently sliding it somewhere else is worse than nothing happening.
    if (!this.legal(turned, index)) return;
    this.list[index] = turned;
    this.apply();
  }

  select(index: number): void {
    this.selected = index >= 0 && index < this.list.length ? index : -1;
    this.apply();
  }

  private legal(p: HomePlacement, ignore: number): boolean {
    if (!placementFits(p, this.opts.bounds)) return false;
    return !this.list.some((other, i) => i !== ignore && placementsOverlap(p, other));
  }

  private apply(): void {
    this.opts.scene.setPlacements(this.list);
    this.highlight();
    this.opts.onChange(this.list.map((p) => ({ ...p })), this.selected);
  }

  /** Lifts the selected piece a hair so it reads as picked up. */
  private highlight(): void {
    const nodes = this.opts.scene.placementNodes;
    nodes.forEach((node, i) => {
      node.position.y = i === this.selected && this.enabled ? 0.035 : 0;
    });
  }

  private toPointer(e: PointerEvent): void {
    const r = this.opts.canvas.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled || e.button !== 0) return;
    this.toPointer(e);
    this.ray.setFromCamera(this.pointer, this.opts.camera);

    const nodes = this.opts.scene.placementNodes as THREE.Object3D[];
    const hits = this.ray.intersectObjects(nodes, true);
    if (!hits.length) { this.select(-1); return; }

    // The hit may be a child mesh; the placement index lives on the node.
    let node: THREE.Object3D | null = hits[0].object;
    while (node && node.userData.placementIndex === undefined) node = node.parent;
    if (!node) { this.select(-1); return; }

    e.preventDefault();
    e.stopPropagation();
    this.selected = node.userData.placementIndex as number;
    this.origin = { ...this.list[this.selected] };
    this.dragging = true;
    this.highlight();
    this.opts.onChange(this.list.map((p) => ({ ...p })), this.selected);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging || this.selected < 0) return;
    this.toPointer(e);
    this.ray.setFromCamera(this.pointer, this.opts.camera);
    if (!this.ray.ray.intersectPlane(this.floor, this.hit)) return;

    const proposed: HomePlacement = {
      ...this.list[this.selected],
      x: snap(this.hit.x),
      z: snap(this.hit.z),
    };
    if (!this.legal(proposed, this.selected)) return;

    this.list[this.selected] = proposed;
    // Only the transform moves while dragging. Rebuilding the geometry every
    // pointermove would regenerate a sofa sixty times a second.
    const node = this.opts.scene.placementNodes[this.selected];
    if (node) node.position.set(proposed.x, 0.035, proposed.z);
    this.opts.onChange(this.list.map((p) => ({ ...p })), this.selected);
  };

  private onUp = () => {
    if (!this.dragging) return;
    this.dragging = false;
    this.origin = null;
    // Rebuild once on drop, which is also what refreshes the collider table.
    this.apply();
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.enabled || this.selected < 0) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

    if (e.key === 'r' || e.key === 'R') { this.rotate(this.selected, e.shiftKey ? -1 : 1); e.preventDefault(); }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.store(); e.preventDefault(); }
    if (e.key === 'Escape') { this.select(-1); }
  };

  dispose(): void {
    this.disable();
    this.origin = null;
  }
}
