import * as THREE from 'three';
import { PK_ARENA } from '@streampolis/shared';
import { LOOK_LIVE } from '../Renderer.js';
import { ROOM_NIGHT } from '../Environment.js';
import { InteriorScene, type InteriorStyle } from './InteriorScene.js';

/**
 * PK Arena (PRD §6, §18): two stages, one floor, and no doubt about which end
 * is which.
 *
 * The room is colour-coded end to end — magenta for side A, blue for side B —
 * because a PK is read at a glance from a phone: whose half is winning has to
 * be legible before any number is. The floor is the scoreboard's backing plate.
 */
const STYLE: InteriorStyle = {
  look: {
    ...LOOK_LIVE, exposure: 0.7, bloomStrength: 0.48, bloomThreshold: 0.84,
    vignette: 0.48, grain: 0.03,
  },
  lighting: {
    ...ROOM_NIGHT,
    ceilingColor: 0x2a3050,
    floorColor: 0x0d0f16,
    ambientIntensity: 0.36,
    keyDirection: [0.1, -0.95, 0.2],
    keyColor: 0x9fb6ff,
    keyIntensity: 0.6,
    keyRadius: 18,
    envTop: 0x141a2a, envSide: 0x191a22, envFloor: 0x080910, envWindow: 0x2a2f4a,
    envIntensity: 0.7,
    fogColor: 0x070810, fogNear: 22, fogFar: 78,
  },
  screen: [0xff3d7f, 0x2f7bff],
  beams: true,
  practicals: 1.0,
  framing: 'room',
  maxBoom: 9.0,
  shell: (lib) => ({
    floor: lib.concrete('#20222b'),
    wall: lib.concrete('#191b22'),
    ceiling: lib.painted(0x0a0b10, 0.95),
    trim: lib.metal('#2c3038', 0.5, 0.8),
    floorTile: 2.4,
    wallTile: 2.6,
    mouldings: false,
  }),
};

export class PkArenaScene extends InteriorScene {
  constructor() {
    super('pk_arena', PK_ARENA, STYLE);
  }

  /** Team halves painted onto the floor, plus the centre line between them. */
  protected override dress(): void {
    for (const [z, hex] of [[-8, 0xff3d7f], [8, 0x2f7bff]] as const) {
      const half = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 15),
        new THREE.MeshBasicMaterial({
          color: hex, transparent: true, opacity: 0.07,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }),
      );
      half.rotation.x = -Math.PI / 2;
      half.position.set(0, 0.01, z);
      this.own(half.material as THREE.Material);
      this.add(half);
    }

    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(32, 0.3),
      new THREE.MeshBasicMaterial({ color: 0xffcc33, fog: false }),
    );
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.02, 0);
    this.own(line.material as THREE.Material);
    this.add(line);
  }
}
