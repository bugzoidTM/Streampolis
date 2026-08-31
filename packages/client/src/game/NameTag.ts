import * as THREE from 'three';
import { GIFTER_TIERS } from '@streampolis/shared';

/**
 * Name above the avatar (SPECs §69). Drawn once into a canvas and reused as a
 * sprite: a DOM overlay would need a projection per frame per player, and text
 * geometry would cost a draw call each.
 *
 * The badge colour is the gifter tier (PRD §17), so who spends is legible from
 * across the plaza without opening a profile.
 */

const PAD = 12;
const FONT_PX = 34;
const cache = new Map<string, THREE.SpriteMaterial>();

function draw(name: string, gifterLevel: number): THREE.SpriteMaterial {
  const key = `${name}|${gifterLevel}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tier = GIFTER_TIERS[Math.max(0, Math.min(gifterLevel, GIFTER_TIERS.length - 1))];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${FONT_PX}px system-ui, sans-serif`;
  const textWidth = ctx.measureText(name).width;
  const badge = gifterLevel > 0 ? FONT_PX * 1.1 : 0;

  canvas.width = Math.ceil(textWidth + badge + PAD * 2);
  canvas.height = Math.ceil(FONT_PX * 1.7);

  // Re-fetch: sizing the canvas resets the 2D context state.
  const c = canvas.getContext('2d')!;
  c.font = `600 ${FONT_PX}px system-ui, sans-serif`;
  c.textBaseline = 'middle';

  const r = canvas.height / 2;
  c.fillStyle = 'rgba(8, 10, 16, 0.62)';
  c.beginPath();
  c.roundRect(0, 0, canvas.width, canvas.height, r);
  c.fill();

  if (badge > 0) {
    c.fillStyle = tier ? tier.color : '#8a93a6';
    c.beginPath();
    c.arc(PAD + badge * 0.35, canvas.height / 2, FONT_PX * 0.32, 0, Math.PI * 2);
    c.fill();
  }

  c.fillStyle = '#f2f5fb';
  c.fillText(name, PAD + badge, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    // Tags belong to the HUD layer conceptually: a lamp post in front of a
    // player must not slice their name in half.
    depthTest: false,
  });
  cache.set(key, material);
  return material;
}

export class NameTag {
  readonly sprite: THREE.Sprite;

  constructor(name: string, gifterLevel: number, private height: number) {
    this.sprite = new THREE.Sprite(draw(name, gifterLevel));
    this.sprite.renderOrder = 10;
    this.applyScale();
  }

  private applyScale(): void {
    const map = (this.sprite.material as THREE.SpriteMaterial).map;
    const image = map?.image as HTMLCanvasElement | undefined;
    const aspect = image ? image.width / image.height : 4;
    const h = 0.16;
    this.sprite.scale.set(h * aspect, h, 1);
    this.sprite.position.y = this.height + 0.18;
  }

  set(name: string, gifterLevel: number, height = this.height): void {
    this.height = height;
    this.sprite.material = draw(name, gifterLevel);
    this.applyScale();
  }

  dispose(): void {
    // The material and its texture live in the shared cache on purpose: two
    // hundred plaza visitors named the same thing cost one texture.
    this.sprite.removeFromParent();
  }
}

/** Frees every cached tag texture. Call on teardown of the last scene. */
export function disposeNameTags(): void {
  for (const material of cache.values()) {
    material.map?.dispose();
    material.dispose();
  }
  cache.clear();
}
