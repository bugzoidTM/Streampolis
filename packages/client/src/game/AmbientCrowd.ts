import * as THREE from 'three';
import { DEFAULT_AVATAR, type AvatarConfig, type CrowdRoutine } from '@streampolis/shared';
import { mulberry32 } from './materials/Noise.js';
import type { AvatarLike } from './avatar/AvatarLike.js';
import { createAvatar } from './avatar/createAvatar.js';

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
  avatar: AvatarLike;
  routine: Routine;
  leg: number;
  linger: number;
  /** Where it is now, and where it is heading. */
  pos: THREE.Vector3;
  heading: number;
}

const WALK_SPEED = 1.15;
const SKIN = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Quem anda na praça.
 *
 * Figurante veste um personagem INTEIRO do pacote, não uma mistura sorteada de
 * peças: uma pessoa de terno com bota de operário e cabeça de punk lê como
 * defeito, e ninguém olha um figurante tempo suficiente para achar graça na
 * combinação. Misturar é privilégio de quem escolhe.
 *
 * A lista é de gente de rua — a bruxa, o astronauta e o rei estão no catálogo
 * da loja e não atravessando a praça.
 */
const STREET = [
  'm_casual_character', 'm_hoodie_character', 'm_business_man', 'm_worker',
  'm_beach_character', 'm_farmer', 'm_punk', 'f_animated_woman',
  'f_suit', 'f_worker', 'f_punk', 'f_adventurer',
];

/**
 * Personagens que o pacote não traz inteiros.
 *
 * O fazendeiro não tem malha de pernas — é o único incompleto dos 21, e a loja
 * já vende só a cabeça, a blusa e o calçado dele. Sem esta linha, todo
 * fazendeiro da praça pedia um `m_farmer_bottom.glb` que não existe, levava 404
 * e caía na calça padrão por exceção. Vestir de propósito é melhor do que
 * acertar por acidente.
 */
const REMENDO: Record<string, Partial<Record<'top' | 'bottom' | 'shoes', string>>> = {
  m_farmer: { bottom: 'm_worker_bottom' },
};

/** A stranger. Deterministic per index, so a scene looks the same twice. */
export function extra(i: number): AvatarConfig {
  const rnd = mulberry32(4801 + i * 7919);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
  const who = pick(STREET);
  return {
    ...DEFAULT_AVATAR,
    skinTone: pick(SKIN),
    hairColor: Math.floor(rnd() * 10),
    hair: `${who}_head`,
    top: REMENDO[who]?.top ?? `${who}_top`,
    bottom: REMENDO[who]?.bottom ?? `${who}_bottom`,
    shoes: REMENDO[who]?.shoes ?? `${who}_shoes`,
    accessory: '',
    height: 0.94 + rnd() * 0.12,
  };
}

/**
 * As peças que os figurantes vão vestir, para quem pré-carrega saber o que
 * buscar.
 *
 * `extra(i)` é determinístico por índice: dá para saber, ANTES de a cena
 * existir, exatamente quais arquivos os figurantes pedirão — e são só uns
 * poucos personagens repetidos, não os doze. Sem isto, o pré-carregamento
 * buscava só o conjunto padrão e a rua começava a se povoar DEPOIS de a tela de
 * carregamento sair, uma pessoa por vez, que é exatamente a impressão de
 * travamento que a tela veio consertar.
 */
export function crowdParts(budget: number): string[] {
  const ids = new Set<string>();
  for (let i = 0; i < budget; i++) {
    const cfg = extra(i);
    for (const id of [cfg.hair, cfg.top, cfg.bottom, cfg.shoes]) if (id) ids.add(id);
  }
  return [...ids];
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
      // Sem rig de expressão: oito meshes por figurante que ninguém vê. (O
      // corpo v2 não tem rig de rosto nenhum, e a opção vira letra morta nele.)
      // Sem sombra e sem rig de expressão, e as duas coisas por OPÇÃO.
      //
      // O `castShadow = false` era um `traverse` no nó recém-criado: no corpo
      // v2 esse nó ainda está vazio (ele se monta quando os quatro arquivos
      // chegam), então a varredura não encontrava malha nenhuma e a montagem
      // acendia todas depois. Os doze figurantes entravam no passe de sombra
      // todo quadro — o oposto exato do que este comentário prometia.
      const avatar = createAvatar(extra(i), { face: false, castShadow: false });
      const start = routine.path[0];
      avatar.root.position.set(start.x, routine.y ?? 0, start.z);
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
