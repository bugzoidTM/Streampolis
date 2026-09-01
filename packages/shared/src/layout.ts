/**
 * Scene layout as DATA.
 *
 * The plaza's furniture lives here, not inside the Three.js scene, for one
 * reason: the server has to know where the fountain is. A collider table
 * written by hand next to a scene that places props with its own numbers
 * drifts within a week — and the way you find out is a player walking through
 * a bench on one machine and bouncing off it on another.
 *
 * Everything below is deterministic: same indices, same coordinates, no RNG.
 * The client reads it to place geometry; the server reads it to refuse moves.
 */

export interface Placement {
  x: number;
  z: number;
  /** Yaw in radians. */
  ry: number;
  /** Uniform scale, 1 when omitted. */
  s?: number;
  /** Selects a variant of the same prop family (tree canopies, façades). */
  variant?: number;
}

/** Um figurante e o que ele faz. Ver `game/AmbientCrowd.ts`. */
export interface CrowdWaypoint { x: number; z: number; wait?: number }
export interface CrowdRoutine {
  kind: 'walk' | 'sit' | 'watch' | 'talk';
  path: CrowdWaypoint[];
  facing?: number;
  /** Altura do quadril. Quem senta precisa da altura do assento, não do chão. */
  y?: number;
}

export interface BuildingPlacement extends Placement {
  width: number;
  depth: number;
  floors: number;
  style: 'townhouse' | 'modern' | 'tower';
  seed: number;
}

const TAU = Math.PI * 2;

/** Points on a ring, facing the centre unless `outward` is set. */
function ring(count: number, radius: number, phase = 0, outward = false): Placement[] {
  const out: Placement[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + phase;
    out.push({
      x: Math.cos(a) * radius,
      z: Math.sin(a) * radius,
      ry: outward ? -a : -a + Math.PI / 2,
    });
  }
  return out;
}

export const PLAZA = {
  radius: 26,
  fountainRadius: 3.2,
  stairInner: 4.0,
  stairSteps: 3,
  /** Radius of the paved apron around the fountain. */
  apron: 9.5,

  benches: ring(10, 9.8, 0.31),
  lamps: ring(8, 14.5, 0, true),
  bollards: ring(40, 27.2, 0, true),
  bins: [0.9, 2.5, 4.1, 5.7].map((a) => ({
    x: Math.cos(a) * 11.4, z: Math.sin(a) * 11.4, ry: -a,
  })),
  planters: ring(6, 12.2, 0.52),
  banners: ring(8, 14.5, 0.39, true),

  // Off-axis on purpose: perfect symmetry everywhere makes a space read as a
  // menu rather than as a square people cross.
  kiosks: [
    { x: Math.cos(0.75) * 17.5, z: Math.sin(0.75) * 17.5, ry: -0.75 + Math.PI, width: 3.2, depth: 2.6 },
    { x: Math.cos(3.95) * 18.2, z: Math.sin(3.95) * 18.2, ry: -3.95 + Math.PI, width: 3.2, depth: 2.6 },
  ],

  /** Three canopy variants interleaved so the tree line is not one stamp. */
  trees: Array.from({ length: 30 }, (_, i) => {
    const variant = i % 3;
    const a = (i / 30) * TAU + variant * 0.037;
    const r = 21 + ((i * 7) % 11) * 0.2;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, ry: (i * 1.37) % TAU, s: 0.92 + ((i * 5) % 7) * 0.043, variant };
  }) as Placement[],

  shrubs: Array.from({ length: 26 }, (_, i) => {
    const a = (i / 26) * TAU + 0.7;
    const r = 18.5 + ((i * 13) % 9) * 0.55;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, ry: (i * 0.9) % TAU, s: 0.8 + ((i * 3) % 5) * 0.12 };
  }) as Placement[],

  buildings: Array.from({ length: 14 }, (_, i): BuildingPlacement => {
    const a = (i / 14) * TAU + 0.11;
    const r = 38;
    const style = i % 5 === 0 ? 'tower' : i % 2 === 0 ? 'modern' : 'townhouse';
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      // Façades are authored facing +Z, so a block on the ring is turned to
      // look back at the plaza.
      ry: -a + Math.PI / 2 + Math.PI,
      width: style === 'tower' ? 12 + (i % 3) * 1.6 : 9 + (i % 4) * 1.3,
      depth: 11 + (i % 3) * 1.4,
      floors: style === 'tower' ? 8 + (i % 5) : 2 + (i % 3),
      style,
      seed: 17 + i,
    };
  }),

  /** The plaza's live billboard (PRD §6). */
  screen: { x: 0, z: -22, ry: Math.PI, width: 9.5, height: 5.2, base: 3.4 },

  /**
   * Rotas dos figurantes. Ficam AQUI, com o resto do mobiliário urbano, pelo
   * mesmo motivo: são posições no mundo, e posição no mundo é dado, não código
   * de cena. Cada rota é feita para ter um motivo visível — atravessar a
   * praça, sentar num banco, olhar o telão, conversar em par, esperar no
   * quiosque. Ninguém aqui é jogador: não têm nome, não colidem e o servidor
   * nunca ouviu falar deles.
   */
  crowd: [
    // Atravessando, em direções diferentes: uma praça em que todos andam para
    // o mesmo lado lê como esteira.
    { kind: 'walk', path: [{ x: -16, z: 12 }, { x: -4, z: 6 }, { x: 6, z: -8, wait: 2.5 }, { x: 15, z: -14 }] },
    { kind: 'walk', path: [{ x: 17, z: 9 }, { x: 5, z: 11 }, { x: -7, z: 13, wait: 1.8 }, { x: -18, z: 5 }] },
    { kind: 'walk', path: [{ x: 0, z: 19 }, { x: 2, z: 11, wait: 3.2 }, { x: 11, z: 4 }, { x: 13, z: 16 }] },
    { kind: 'walk', path: [{ x: -13, z: -13 }, { x: -6, z: -4, wait: 2.0 }, { x: 4, z: 3 }, { x: 12, z: 12 }] },

    // Sentados nos bancos do anel interno. Vão na MESMA circunferência dos
    // bancos e na altura do assento: no chão, um figurante sentado atravessa
    // o banco e lê como alguém caído.
    { kind: 'sit', y: 0.44, path: [{ x: Math.cos(0.31 + 0.628) * 9.8, z: Math.sin(0.31 + 0.628) * 9.8 }], facing: -(0.31 + 0.628) + Math.PI / 2 },
    { kind: 'sit', y: 0.44, path: [{ x: Math.cos(0.31 + 2.513) * 9.8, z: Math.sin(0.31 + 2.513) * 9.8 }], facing: -(0.31 + 2.513) + Math.PI / 2 },

    // Olhando o telão, que é o ponto do produto: a praça mostra o feed.
    { kind: 'watch', path: [{ x: -1.8, z: -14.5 }], facing: Math.PI },
    { kind: 'watch', path: [{ x: 1.6, z: -13.2 }], facing: Math.PI },
    { kind: 'watch', path: [{ x: 3.4, z: -15.6 }], facing: Math.PI + 0.2 },

    // Um par de frente um para o outro: lado a lado leriam como fila.
    { kind: 'talk', path: [{ x: -8.6, z: 2.2 }], facing: Math.PI / 2 + 0.2 },
    { kind: 'talk', path: [{ x: -7.4, z: 2.6 }], facing: -Math.PI / 2 + 0.2 },

    // Esperando no quiosque.
    { kind: 'watch', path: [{ x: Math.cos(0.75) * 15.4, z: Math.sin(0.75) * 15.4 }], facing: 0.75 },
    { kind: 'talk', path: [{ x: Math.cos(3.95) * 16.0, z: Math.sin(3.95) * 16.0 }], facing: 3.95 },
    { kind: 'walk', path: [{ x: 20, z: -6 }, { x: 9, z: -9, wait: 4.0 }, { x: 8, z: 2 }, { x: 19, z: 3 }] },
  ] as CrowdRoutine[],
} as const;
