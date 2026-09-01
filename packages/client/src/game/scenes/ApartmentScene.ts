import * as THREE from 'three';
import { APARTMENT } from '@streampolis/shared';
import { LOOK_INTERIOR } from '../Renderer.js';
import { ROOM_DAY } from '../Environment.js';
import { makeCameraTransparent } from '../CameraManager.js';
import { InteriorScene, type InteriorStyle } from './InteriorScene.js';
import { assetPassEnabled } from '../assets/pass.js';

/**
 * The studio flat every player starts with (PRD §14).
 *
 * Lit as one room with one window: a warm key raking in from the north-west
 * corner, practicals doing the rest. The trap with a small interior is lighting
 * it evenly — an evenly lit room has no depth and reads as a menu background.
 */
const STYLE: InteriorStyle = {
  framing: 'interior',
  // Exposição meio ponto abaixo com o passe ligado. A mobília do pacote é mais
  // clara que a procedural — creme e madeira clara onde havia azul e cinza —,
  // e a mesma exposição que estava certa antes estoura a parede e o sofá
  // juntos. Quarto claro é escolha; branco recortado é engano.
  look: assetPassEnabled()
    ? { ...LOOK_INTERIOR, exposure: 0.82, contrast: 1.1, vignette: 0.34, bloomStrength: 0.18 }
    : { ...LOOK_INTERIOR, exposure: 0.92, contrast: 1.04, vignette: 0.3, bloomStrength: 0.22 },
  lighting: {
    ...ROOM_DAY,
    // Straight down the window's axis, low enough to throw a long shadow
    // across the floor instead of a puddle under each leg.
    keyDirection: [-0.28, -0.55, 0.79],
    keyIntensity: 3.0,
    keyRadius: 6,
    ambientIntensity: 0.42,
    envWindow: 0xdceeff,
    fogNear: 30, fogFar: 120,
  },
  screen: [0xff3d7f, 0x2f7bff],
  practicals: 1,
  shell: (lib) => ({
    floor: lib.wood('#a9784b'),
    wall: lib.plaster('#e7e0d4'),
    ceiling: lib.plaster('#f2eee7'),
    trim: lib.painted(0xf4f1ea, 0.42),
    floorTile: 1.1,
    wallTile: 1.6,
    view: { top: 0x7fa8d8, bottom: 0xcfdcea, sun: 0xf1e2c8 },
  }),
};

export class ApartmentScene extends InteriorScene {
  constructor() {
    super('apartment', APARTMENT, STYLE);
  }

  /** A rug of daylight on the floor, so the window is felt and not just seen. */
  protected override dress(): void {
    const patch = new THREE.Mesh(
      new THREE.PlaneGeometry(3.0, 2.2),
      new THREE.MeshBasicMaterial({
        color: 0xfff0d2, transparent: true, opacity: 0.1,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    patch.rotation.x = -Math.PI / 2;
    patch.rotation.z = 0.24;
    patch.position.set(0.2, 0.02, -1.6);
    this.own(patch.material as THREE.Material);
    this.add(makeCameraTransparent(patch));
  }
}
