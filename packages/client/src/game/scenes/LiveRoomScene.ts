import * as THREE from 'three';
import { LIVE_ROOM } from '@streampolis/shared';
import { LOOK_LIVE } from '../Renderer.js';
import { ROOM_NIGHT } from '../Environment.js';
import { InteriorScene, type InteriorStyle } from './InteriorScene.js';

/**
 * The set a broadcast happens in (PRD §10, SPECs §10).
 *
 * A live room is a television studio, not a flat: dark surfaces so the LED
 * wall is the brightest thing in frame, three lamps with visible cones, and a
 * mark on the floor telling the host where the shot is. Everything here is
 * chosen so a host standing on the mark is separated from the background by
 * light rather than by outline.
 */
const STYLE: InteriorStyle = {
  // Exposure well under 1: the room is lit by emitters, and at the neutral
  // stop the LED wall and every neon in frame clip to white together.
  look: {
    ...LOOK_LIVE, exposure: 0.74, bloomStrength: 0.44, bloomThreshold: 0.84,
    vignette: 0.44,
  },
  lighting: {
    ...ROOM_NIGHT,
    ceilingColor: 0x3a2f52,
    floorColor: 0x141018,
    ambientIntensity: 0.42,
    keyDirection: [-0.25, -0.85, 0.46],
    keyColor: 0xffd9ee,
    keyIntensity: 0.8,
    keyRadius: 7,
    envTop: 0x241c34, envSide: 0x1b1a22, envFloor: 0x0c0b10, envWindow: 0x5a2a54,
    envIntensity: 0.85,
    fogColor: 0x0a0810, fogNear: 14, fogFar: 46,
  },
  screen: [0xff3d7f, 0x2f7bff],
  beams: true,
  practicals: 1.3,
  shell: (lib) => ({
    floor: lib.carpet('#241f2c'),
    wall: lib.slats('#2a2532'),
    ceiling: lib.painted(0x14121a, 0.9),
    trim: lib.metal('#3a3543', 0.5, 0.7),
    floorTile: 1.4,
    wallTile: 1.1,
    mouldings: true,
  }),
};

export class LiveRoomScene extends InteriorScene {
  constructor() {
    super('live_room', LIVE_ROOM, STYLE);
  }

  /**
   * Backdrop haze. A dark studio with clean air looks like an empty box; a
   * single soft gradient behind the LED wall gives the light somewhere to sit.
   */
  protected override dress(): void {
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(9.0, 4.2),
      new THREE.MeshBasicMaterial({
        color: 0x4a1f52, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    glow.position.set(0, 2.1, -4.7);
    this.own(glow.material as THREE.Material);
    this.add(glow);
  }
}
