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

/**
 * A marca de personagem da cidade (PRD §25: "NPCs nunca deverão ser
 * apresentados como jogadores humanos reais"). Vai na PLACA, e não só no
 * painel de chat, porque a placa é o que se vê de quem ainda não falou.
 */
const NPC_LABEL = 'NPC';
const NPC_FONT_PX = 20;

function draw(name: string, gifterLevel: number, npc = false): THREE.SpriteMaterial {
  const key = `${name}|${gifterLevel}|${npc ? 'npc' : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tier = GIFTER_TIERS[Math.max(0, Math.min(gifterLevel, GIFTER_TIERS.length - 1))];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${FONT_PX}px system-ui, sans-serif`;
  const textWidth = ctx.measureText(name).width;
  const badge = gifterLevel > 0 ? FONT_PX * 1.1 : 0;
  ctx.font = `800 ${NPC_FONT_PX}px system-ui, sans-serif`;
  const npcWidth = npc ? ctx.measureText(NPC_LABEL).width + NPC_FONT_PX * 0.9 : 0;
  const npcGap = npc ? FONT_PX * 0.35 : 0;

  canvas.width = Math.ceil(textWidth + badge + npcGap + npcWidth + PAD * 2);
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

  if (npc) {
    // Um selo azul-claro, nunca da cor de um tier: a cor de quem gasta não
    // pode ser emprestada a quem não gasta.
    const x = PAD + badge + textWidth + npcGap;
    const h = NPC_FONT_PX * 1.35;
    const y = (canvas.height - h) / 2;
    c.fillStyle = 'rgba(112, 214, 255, 0.22)';
    c.strokeStyle = 'rgba(112, 214, 255, 0.7)';
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(x, y, npcWidth, h, 6);
    c.fill();
    c.stroke();
    c.font = `800 ${NPC_FONT_PX}px system-ui, sans-serif`;
    c.fillStyle = '#bfefff';
    c.fillText(NPC_LABEL, x + NPC_FONT_PX * 0.45, canvas.height / 2 + 1);
  }

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

  constructor(name: string, gifterLevel: number, private height: number, private npc = false) {
    // `height` é a ESTATURA do avatar: do chão ao alto do crânio.
    this.sprite = new THREE.Sprite(draw(name, gifterLevel, npc));
    this.sprite.renderOrder = 10;
    this.applyScale();
  }

  private applyScale(): void {
    const map = (this.sprite.material as THREE.SpriteMaterial).map;
    const image = map?.image as HTMLCanvasElement | undefined;
    const aspect = image ? image.width / image.height : 4;
    const h = 0.16;
    this.sprite.scale.set(h * aspect, h, 1);
    // 12 cm acima da COROA. O valor era 0,18 sobre um "eyeHeight" que valia o
    // osso da cabeça: dava 1,66 num corpo de 1,666 — a placa pousava no cabelo.
    this.sprite.position.y = this.height + 0.12;
  }

  set(name: string, gifterLevel: number, height = this.height, npc = this.npc): void {
    this.height = height;
    this.npc = npc;
    this.sprite.material = draw(name, gifterLevel, npc);
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
