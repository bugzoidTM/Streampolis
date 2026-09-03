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

/**
 * Um anel de quarteirões, com a rua entre eles.
 *
 * A largura sai do ARCO disponível: `count` peças num anel de raio `radius`
 * têm 2πr/count de espaço cada, e um quarteirão que não deixa vão nenhum é um
 * muro circular. O que sobra do arco é a rua — e é por ela que se enxerga o
 * anel seguinte.
 */
function district(
  count: number, radius: number, phase: number,
  minFloors: number, maxFloors: number, minWidth: number, maxWidth: number,
): BuildingPlacement[] {
  return Array.from({ length: count }, (_, i): BuildingPlacement => {
    const slot = TAU / count;
    // Jitter determinístico: um anel perfeitamente regular lê como cerca.
    const a = i * slot + phase + (((i * 37) % 11) / 11 - 0.5) * slot * 0.34;
    const r = radius + (((i * 23) % 9) - 4) * 1.3;
    const style = i % 7 === 0 ? 'tower' : i % 2 === 0 ? 'modern' : 'townhouse';
    const width = minWidth + ((i * 13) % 7) / 6 * (maxWidth - minWidth);
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      ry: -a + Math.PI / 2 + Math.PI,
      width,
      depth: 10 + ((i * 17) % 5) * 1.6,
      floors: minFloors + ((i * 29) % (maxFloors - minFloors + 1)),
      style,
      seed: 101 + i * 3 + Math.round(radius),
    };
  });
}

/** Silhuetas do fundo. Mesma ideia, sem estilo: a esta distância é volume. */
function skylineRing(
  count: number, radius: number, phase: number,
  minHeight: number, maxHeight: number, minWidth: number, maxWidth: number,
): BuildingPlacement[] {
  return Array.from({ length: count }, (_, i): BuildingPlacement => {
    const slot = TAU / count;
    const a = i * slot + phase + (((i * 41) % 13) / 13 - 0.5) * slot * 0.5;
    const r = radius + (((i * 31) % 11) - 5) * 3.2;
    const h = minHeight + ((i * 19) % 9) / 8 * (maxHeight - minHeight);
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      ry: -a + Math.PI / 2,
      width: minWidth + ((i * 11) % 6) / 5 * (maxWidth - minWidth),
      depth: 12 + ((i * 7) % 5) * 2.4,
      // `floors` guarda a ALTURA em metros aqui: a silhueta não tem andar.
      floors: h,
      style: 'tower',
      seed: 401 + i * 5 + Math.round(radius),
    };
  });
}

/**
 * Raio do anel de bancos. Nomeado porque DOIS lugares precisam dele: a fileira
 * de bancos e os figurantes que se sentam nela. Enquanto era um literal em
 * cada, mover a praça deixava gente sentada no ar.
 */
const BENCH_R = 15.2;

/**
 * Fator com que a praça cresceu de 26 m para 40 m de raio.
 *
 * Existe para as ROTAS dos figurantes: elas são caminhos autorais, medidos na
 * praça antiga, e o certo é o mesmo trajeto num lugar maior — não trajetos
 * novos inventados à mão. Os raios das fileiras, esses, estão escritos com o
 * número novo: são a planta, e planta se lê, não se calcula.
 */
const SPREAD = 40 / 26;
const spread = (p: CrowdWaypoint): CrowdWaypoint => ({
  x: Math.round(p.x * SPREAD * 10) / 10,
  z: Math.round(p.z * SPREAD * 10) / 10,
  ...(p.wait === undefined ? {} : { wait: p.wait }),
});

export const PLAZA = {
  /**
   * A praça cresceu de 26 m para 40 m de raio (de 52 para 80 m de ponta a
   * ponta), e o anel de fachadas foi de 38 para 58 m.
   *
   * A queixa era "os arredores estão muito pequenos", e ela era literal: o
   * disco andável acabava a 26 m do centro com as fachadas encostadas nele,
   * então a praça inteira cabia num olhar e não havia para onde ir. Crescer o
   * disco sem crescer o resto seria pior — um descampado calçado —, então cada
   * fileira cresceu junto E ganhou peças: dezesseis bancos em vez de dez,
   * quarenta e quatro árvores em vez de trinta, doze postes em vez de oito. A
   * densidade é a mesma; o lugar é que é maior.
   */
  radius: 40,
  fountainRadius: 4.2,
  stairInner: 5.2,
  stairSteps: 3,
  /** Radius of the paved apron around the fountain. */
  apron: 14,

  /**
   * Dois anéis: o de dentro olhando a fonte, o de fora sob as árvores.
   *
   * O segundo é filho do tamanho novo. Com o disco a 40 m, um anel só de
   * bancos a 15 m deixava vinte metros de calçamento sem nada em pé — e chão
   * vazio a perder de vista é o que faz um lugar grande parecer um pátio de
   * estacionamento em vez de uma praça.
   */
  benches: [...ring(16, BENCH_R, 0.31), ...ring(12, 30.5, 0.13)],

  /**
   * Caminhos radiais, da beira do adro até a borda.
   *
   * Não são só desenho: os três primeiros apontam para as três portas da praça
   * (`portals.ts`), então o piso passa a dizer para onde se vai. Numa praça de
   * 26 m dava para ver a porta de qualquer ponto; numa de 40 m, não — e um
   * lugar grande sem eixo é um lugar em que se anda à toa.
   */
  paths: [0, TAU / 3, (TAU * 2) / 3, TAU / 6, TAU / 2, (TAU * 5) / 6],
  lamps: ring(12, 22.5, 0, true),
  bollards: ring(58, 41.5, 0, true),
  bins: [0.9, 2.0, 3.1, 4.2, 5.3, 6.1].map((a) => ({
    x: Math.cos(a) * 17.6, z: Math.sin(a) * 17.6, ry: -a,
  })),
  planters: ring(8, 19, 0.52),
  banners: ring(12, 22.5, 0.39, true),

  // Off-axis on purpose: perfect symmetry everywhere makes a space read as a
  // menu rather than as a square people cross.
  kiosks: [
    { x: Math.cos(0.75) * 27.0, z: Math.sin(0.75) * 27.0, ry: -0.75 + Math.PI, width: 3.2, depth: 2.6 },
    { x: Math.cos(3.95) * 28.2, z: Math.sin(3.95) * 28.2, ry: -3.95 + Math.PI, width: 3.2, depth: 2.6 },
    // O terceiro é filho do tamanho novo: com 80 m de ponta a ponta, dois
    // quiosques deixam um terço do anel sem nada em pé para olhar.
    { x: Math.cos(2.35) * 27.6, z: Math.sin(2.35) * 27.6, ry: -2.35 + Math.PI, width: 3.2, depth: 2.6 },
  ],

  /** Three canopy variants interleaved so the tree line is not one stamp. */
  trees: Array.from({ length: 44 }, (_, i) => {
    const variant = i % 3;
    const a = (i / 44) * TAU + variant * 0.037;
    const r = 32 + ((i * 7) % 11) * 0.3;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, ry: (i * 1.37) % TAU, s: 0.92 + ((i * 5) % 7) * 0.043, variant };
  }) as Placement[],

  shrubs: Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * TAU + 0.7;
    const r = 28.5 + ((i * 13) % 9) * 0.7;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, ry: (i * 0.9) % TAU, s: 0.8 + ((i * 3) % 5) * 0.12 };
  }) as Placement[],

  /**
   * O anel de fachadas — com as BOCAS DE RUA abertas nos três eixos das portas.
   *
   * Um anel fechado é um muro, por mais bonita que seja cada fachada: a vista
   * bate na fileira e para, e é isso que fazia a cidade acabar a 58 m. Onde o
   * caminho radial encontra o anel, a fatia é deixada VAZIA — e o que se vê
   * pela abertura é o bairro de trás (`districts`), que já está lá. A porta
   * daquele eixo (`portals.ts`) fica bem na boca da rua, que é onde uma porta
   * deve estar: no fim da rua que leva a ela.
   */
  buildings: Array.from({ length: 20 }, (_, i) => i).filter((i) => {
    const a = (i / 20) * TAU + 0.11;
    return ![0, TAU / 3, (TAU * 2) / 3].some((street) => {
      const d = Math.abs(((a - street + Math.PI) % TAU + TAU) % TAU - Math.PI);
      return d < TAU / 20;
    });
  }).map((i): BuildingPlacement => {
    const a = (i / 20) * TAU + 0.11;
    const r = 58;
    const style = i % 5 === 0 ? 'tower' : i % 2 === 0 ? 'modern' : 'townhouse';
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      // Façades are authored facing +Z, so a block on the ring is turned to
      // look back at the plaza.
      ry: -a + Math.PI / 2 + Math.PI,
      // O anel novo tem 58 m de raio: 20 fatias de 18 m de arco. As fachadas
      // ficaram mais largas junto, ou o anel seria uma cerca de estacas.
      width: style === 'tower' ? 13 + (i % 3) * 1.8 : 10 + (i % 4) * 1.5,
      depth: 12 + (i % 3) * 1.6,
      floors: style === 'tower' ? 9 + (i % 5) : 3 + (i % 3),
      style,
      seed: 17 + i,
    };
  }),

  /**
   * A cidade ATRÁS do anel da praça.
   *
   * O anel de catorze fachadas fechava o quadro a 38 m e não havia mais nada:
   * a praça lia como um pátio cercado, e a queixa foi essa — "os arredores
   * estão muito pequenos". O que dá tamanho a um lugar não é o lugar, é o que
   * se vê ALÉM dele: quarteirões pelos vãos, ruas que continuam, telhados
   * ficando menores até a névoa.
   *
   * São só DESENHO. Não entram na tabela de colisão de propósito: o disco
   * andável termina muito antes, e um obstáculo que ninguém pode tocar é peso
   * que o servidor carrega por nada.
   *
   * Cada anel é meio vão fora de fase com o anterior. Alinhados, os vãos
   * abririam corredores retos até a névoa e a cidade viraria uma paliçada com
   * frestas; desencontrados, cada fresta mostra uma parede mais atrás — que é
   * exatamente a leitura de profundidade que se quer.
   */
  districts: [
    district(20, 80, 0.11 + Math.PI / 20, 3, 9, 11, 17),
    district(26, 106, 0.11 + Math.PI / 13, 5, 14, 12, 19),
  ].flat(),

  /**
   * O horizonte: massas sem janela, sem sombra, cada vez mais altas e mais
   * apagadas pela névoa. Custam uma chamada de desenho as duas dezenas.
   */
  skyline: [
    skylineRing(28, 138, 0.4, 26, 62, 13, 24),
    skylineRing(24, 178, 1.1, 40, 96, 17, 30),
  ].flat(),

  /** The plaza's live billboard (PRD §6). */
  /**
   * O telão (PRD §6) — virado PARA a praça.
   *
   * Estava com `ry: Math.PI`, isto é, de costas: quem chegava via a traseira de
   * metal escuro do painel, e os figurantes autorados para "olhar o telão"
   * olhavam para ela. A convenção é a mesma dos painéis do Live Room
   * (`interiors.ts`): a peça é autorada olhando para +Z, então um painel na
   * borda NORTE, em z negativo, olha para a praça com `ry: 0`. Só apareceu
   * quando a praça cresceu e o painel ficou grande o bastante para dominar o
   * horizonte — de costas.
   */
  screen: { x: 0, z: -34, ry: 0, width: 13.5, height: 7.4, base: 4.2 },

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
    // o mesmo lado lê como esteira. Os trajetos são os mesmos de sempre, no
    // tamanho novo do lugar (ver `SPREAD`).
    { kind: 'walk', path: [{ x: -16, z: 12 }, { x: -4, z: 6 }, { x: 6, z: -8, wait: 2.5 }, { x: 15, z: -14 }].map(spread) },
    { kind: 'walk', path: [{ x: 17, z: 9 }, { x: 5, z: 11 }, { x: -7, z: 13, wait: 1.8 }, { x: -18, z: 5 }].map(spread) },
    { kind: 'walk', path: [{ x: 0, z: 19 }, { x: 2, z: 11, wait: 3.2 }, { x: 11, z: 4 }, { x: 13, z: 16 }].map(spread) },
    { kind: 'walk', path: [{ x: -13, z: -13 }, { x: -6, z: -4, wait: 2.0 }, { x: 4, z: 3 }, { x: 12, z: 12 }].map(spread) },

    // Sentados nos bancos do anel interno. Vão na MESMA circunferência dos
    // bancos e na altura do assento: no chão, um figurante sentado atravessa
    // o banco e lê como alguém caído.
    { kind: 'sit', y: 0.44, path: [{ x: Math.cos(0.31 + 0.393) * BENCH_R, z: Math.sin(0.31 + 0.393) * BENCH_R }], facing: -(0.31 + 0.393) + Math.PI / 2 },
    { kind: 'sit', y: 0.44, path: [{ x: Math.cos(0.31 + 2.749) * BENCH_R, z: Math.sin(0.31 + 2.749) * BENCH_R }], facing: -(0.31 + 2.749) + Math.PI / 2 },

    // Olhando o telão, que é o ponto do produto: a praça mostra o feed.
    { kind: 'watch', path: [{ x: -2.4, z: -25.0 }], facing: Math.PI },
    { kind: 'watch', path: [{ x: 2.2, z: -23.4 }], facing: Math.PI },
    { kind: 'watch', path: [{ x: 4.6, z: -26.2 }], facing: Math.PI + 0.2 },

    // Um par de frente um para o outro: lado a lado leriam como fila.
    { kind: 'talk', path: [{ x: -12.4, z: 3.4 }], facing: Math.PI / 2 + 0.2 },
    { kind: 'talk', path: [{ x: -11.2, z: 3.8 }], facing: -Math.PI / 2 + 0.2 },

    // Esperando no quiosque.
    { kind: 'watch', path: [{ x: Math.cos(0.75) * 24.4, z: Math.sin(0.75) * 24.4 }], facing: 0.75 },
    { kind: 'talk', path: [{ x: Math.cos(3.95) * 25.2, z: Math.sin(3.95) * 25.2 }], facing: 3.95 },
    { kind: 'talk', path: [{ x: Math.cos(2.35) * 24.8, z: Math.sin(2.35) * 24.8 }], facing: 2.35 },
    { kind: 'walk', path: [{ x: 20, z: -6 }, { x: 9, z: -9, wait: 4.0 }, { x: 8, z: 2 }, { x: 19, z: 3 }].map(spread) },
  ] as CrowdRoutine[],
} as const;
