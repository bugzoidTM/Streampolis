import * as THREE from 'three';
import { DEFAULT_AVATAR, type AvatarConfig, type CrowdRoutine } from '@streampolis/shared';
import { mulberry32 } from './materials/Noise.js';
import { Avatar } from './avatar/Avatar.js';

/**
 * Decorative crowd.
 *
 * An empty city reads as a demo; a city with movement in it reads as a world.
 * That is the whole argument for this file, and it is worth the draw calls it
 * costs: no amount of paving detail buys what one person walking across the
 * square buys.
 *
 * These are NOT players and never pretend to be. They carry no name tag, they
 * cannot be talked to, they do not collide with anyone, and the server has
 * never heard of them. A waypoint walk is enough — A → B → C → wait → D —
 * because the eye reads intent from a path, not from a plan.
 *
 * The count comes from `QualityManager.ambientNpcs`, so a low tier gets none
 * rather than a slideshow.
 */

export type Routine = CrowdRoutine;

interface Member {
  avatar: Avatar;
  routine: Routine;
  leg: number;
  linger: number;
  /** Where it is now, and where it is heading. */
  pos: THREE.Vector3;
  heading: number;
}

const WALK_SPEED = 1.15;
const SKIN = [0, 1, 2, 3, 4, 5, 6, 7];
const HAIRS = [
  'hair_crop_01', 'hair_bob_01', 'hair_buzz_01', 'hair_wave_01',
  'hair_ponytail_01', 'hair_long_01', 'hair_braids_01', 'hair_afro_01',
];
const TOPS = ['top_tee_01', 'top_hoodie_01', 'top_shirt_01', 'top_knit_01', 'top_jacket_01', 'top_tank_01'];
const BOTTOMS = ['bottom_jeans_01', 'bottom_cargo_01', 'bottom_skirt_01', 'bottom_wide_01', 'bottom_shorts_01'];
const SHOES = ['shoes_sneaker_01', 'shoes_boot_01', 'shoes_loafer_01', 'shoes_hitop_01'];

/** A stranger. Deterministic per index, so a scene looks the same twice. */
function extra(i: number): AvatarConfig {
  const rnd = mulberry32(4801 + i * 7919);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
  return {
    ...DEFAULT_AVATAR,
    bodyPreset: Math.floor(rnd() * 4),
    facePreset: Math.floor(rnd() * 4),
    skinTone: pick(SKIN),
    hair: pick(HAIRS),
    hairColor: Math.floor(rnd() * 10),
    top: pick(TOPS),
    bottom: pick(BOTTOMS),
    shoes: pick(SHOES),
    accessory: rnd() < 0.35 ? pick(['acc_cap_01', 'acc_glasses_01', 'acc_beanie_01', 'acc_chain_01']) : '',
    height: 0.94 + rnd() * 0.12,
  };
}

export class AmbientCrowd {
  private members: Member[] = [];
  private root = new THREE.Group();

  constructor(scene: THREE.Scene, routines: readonly Routine[], budget: number) {
    this.root.name = 'ambient-crowd';
    scene.add(this.root);

    const count = Math.min(budget, routines.length);
    for (let i = 0; i < count; i++) {
      const routine = routines[i];
      // Sem rig de expressão: oito meshes por figurante que ninguém vê.
      const avatar = new Avatar(extra(i), { face: false });
      const start = routine.path[0];
      avatar.root.position.set(start.x, routine.y ?? 0, start.z);
      // No shadow casting: a crowd of shadow casters doubles the shadow pass
      // for figures the player never looks at directly.
      avatar.root.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
      this.root.add(avatar.root);

      const member: Member = {
        avatar,
        routine,
        leg: 0,
        // Staggered so a row of strangers does not step in unison.
        linger: (i * 0.7) % 3,
        pos: new THREE.Vector3(start.x, routine.y ?? 0, start.z),
        heading: routine.facing ?? 0,
      };
      this.members.push(member);
      this.pose(member, true);
    }
  }

  /** Which clip a routine sits in while it is not walking. */
  private pose(m: Member, initial = false): void {
    const idle = m.routine.kind === 'sit' ? 'sit' : 'idle';
    m.avatar.setAnim(m.routine.kind === 'walk' && !initial ? 'walk' : idle);
    // A pair standing face to face reads as a conversation; the same two side
    // by side read as a queue. The facing is the whole staging.
    if (m.routine.kind !== 'walk') m.avatar.root.rotation.y = m.routine.facing ?? 0;
  }

  update(dt: number): void {
    for (const m of this.members) {
      if (m.routine.kind === 'walk') this.walk(m, dt);
      // Speed drives the locomotion clip's timing, so a stander must report 0
      // or its feet slide on the spot.
      m.avatar.animate(dt, m.routine.kind === 'walk' && m.linger <= 0 ? WALK_SPEED : 0);
    }
  }

  private walk(m: Member, dt: number): void {
    if (m.linger > 0) {
      m.linger -= dt;
      if (m.linger <= 0) m.avatar.setAnim('walk');
      return;
    }

    const target = m.routine.path[m.leg];
    const dx = target.x - m.pos.x;
    const dz = target.z - m.pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 0.12) {
      m.leg = (m.leg + 1) % m.routine.path.length;
      m.linger = target.wait ?? 0;
      if (m.linger > 0) m.avatar.setAnim('idle');
      return;
    }

    const step = Math.min(dist, WALK_SPEED * dt);
    m.pos.x += (dx / dist) * step;
    m.pos.z += (dz / dist) * step;
    m.avatar.root.position.set(m.pos.x, m.routine.y ?? 0, m.pos.z);

    // Turn toward the heading instead of snapping: a stranger that pivots
    // instantly at a corner is the tell that nothing here is alive.
    const want = Math.atan2(dx, dz);
    let delta = want - m.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    m.heading += delta * Math.min(1, dt * 6);
    m.avatar.root.rotation.y = m.heading;
  }

  dispose(): void {
    for (const m of this.members) {
      this.root.remove(m.avatar.root);
      m.avatar.dispose();
    }
    this.members = [];
    this.root.parent?.remove(this.root);
  }
}
