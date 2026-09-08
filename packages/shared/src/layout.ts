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
  /**
   * `dance` entrou com o clube: os outros quatro são jeitos de estar PARADO, e
   * um clube cheio de figurantes de pé é um saguão com música.
   */
  kind: 'walk' | 'sit' | 'watch' | 'talk' | 'dance';
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
/**
 * Os eixos que viram RUA: asfalto saindo da praça e um vão no anel de fachadas.
 *
 * Fica fora do objeto porque DUAS entradas dele precisam da lista, e um objeto
 * não pode se referenciar enquanto está sendo montado. Enquanto era um literal
 * repetido no filtro das fachadas e um `slice(0, 3)` na cena, abrir a quarta
 * boca — a do Distrito Sombra — teria aberto o vão sem a rua ou a rua contra a
 * parede.
 */
const STREETS = [0, TAU / 3, (TAU * 2) / 3, TAU / 2];

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

  /**
   * Quais dos caminhos radiais viram RUA de asfalto e abrem o anel de fachadas.
   *
   * Era `paths.slice(0, 3)` na cena e uma lista literal repetida no filtro das
   * fachadas — duas cópias da mesma decisão em arquivos diferentes. Abrir a
   * quarta boca (a do Distrito Sombra) com elas separadas teria aberto o vão
   * sem a rua, ou a rua contra uma parede.
   */
  streets: STREETS,
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

  /**
   * Three canopy variants interleaved so the tree line is not one stamp.
   *
   * ## A clareira na frente do telão
   *
   * As árvores nascem num anel de raio 32–35 e o telão está em `(0, -34)` —
   * ou seja, DENTRO do anel. Uma delas caía bem na frente do painel e tapava
   * o vídeo.
   *
   * Apagar aquela árvore à mão não resolveria nada por muito tempo: elas são
   * geradas, e mudar a contagem de 44 para 45 poria outra no mesmo lugar. O
   * que se abre aqui é uma CLAREIRA — a fatia do anel na direção do telão fica
   * vazia, e continua vazia mesmo que a fórmula mude.
   *
   * A janela é a largura angular do painel (13,5 m a 34 m de distância dão
   * ±0,20 rad) mais uma folga para quem olha de lado. Praça com telão tem
   * praça na frente dele; é assim em qualquer praça de verdade.
   */
  trees: Array.from({ length: 44 }, (_, i) => {
    const variant = i % 3;
    const a = (i / 44) * TAU + variant * 0.037;
    const r = 32 + ((i * 7) % 11) * 0.3;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, ry: (i * 1.37) % TAU, s: 0.92 + ((i * 5) % 7) * 0.043, variant, a };
  }).filter(({ a }) => {
    // Direção do telão vista do centro da praça: `atan2(-34, 0)`.
    const alvo = Math.atan2(-34, 0);
    const d = Math.abs(((a - alvo + Math.PI) % TAU + TAU) % TAU - Math.PI);
    return d > 0.34;
  }).map(({ a, ...arvore }) => arvore) as Placement[],

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
    return !STREETS.some((street) => {
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

/**
 * Distrito Sombra — o primeiro bairro além da praça (PRD §34, "Novos bairros").
 *
 * É uma RUA, não um pátio, e essa é a decisão que organiza toda a tabela
 * abaixo. A praça é um disco com um monumento no meio: o olho corre até a
 * borda e volta. Um quarteirão é o contrário — duas fileiras de fachadas
 * fechando um corredor, e tudo o que interessa acontece entre elas. Sem esse
 * aperto não existe beco, não existe néon refletido no asfalto e não existe
 * para onde uma entrega ir.
 *
 * ## O bairro cresceu, e virou DUAS ruas
 *
 * A primeira versão era um corredor de 68 m com um beco. Dava para atravessar
 * o bairro inteiro em vinte e cinco segundos andando, e o defeito disso não
 * era o tamanho em metros — era não haver **para onde virar**. Uma rua só é
 * um corredor; o que faz um bairro é a esquina, o atalho e o lugar aonde não
 * se chega sem querer.
 *
 * ```
 *   z = -56  ══════════════════════════════════════  fundos da travessa
 *   z = -46  ══════════════════════════════════════  fachadas norte  ┐
 *                    T   R   A   V   E   S   S   A                   │ rua 2
 *   z = -33  ═══╤════════════════╤═════════════╤════  fachadas sul   ┘
 *               │                │             │
 *          passagem O        BECO (sem saída)  passagem L
 *               │                │             │
 *   z =  -9  ═══╧════════════════╧═════════════╧════  fachadas norte ┐
 *                    A   V   E   N   I   D   A                       │ rua 1
 *   z =  +9  ══════════════════════════════════════  fachadas sul    ┘
 *
 *        x = -58                                              x = +58
 * ```
 *
 * Três coisas saíram dessa planta e nenhuma delas é decoração:
 *
 * 1. **Duas passagens que atravessam** (oeste e leste) e **um beco que não
 *    atravessa**. O beco continua sem saída de propósito — ele é o lugar onde
 *    alguém está, não um atalho —, e agora a parede cega dele É o fundo dos
 *    prédios da travessa. Deixou de ser um prédio inventado só para tapar.
 * 2. **A avenida quase dobrou** (68 m → 116 m). Atravessá-la andando leva
 *    quase um minuto, e é exatamente por isso que **correr** deixou de ser um
 *    detalhe de teclado e virou controle de tela (ver `RunToggle`).
 * 3. **A travessa é o oposto da avenida**: mais estreita, mais baixa, com
 *    menos néon. Ela existe para que a avenida tenha um "atrás" — e para que a
 *    silhueta vista da passagem não seja o vazio.
 *
 * A área andável continua sendo UM retângulo (`Area` só sabe ser disco ou
 * retângulo). O desenho das ruas vem inteiro dos COLISORES: as fachadas são as
 * paredes, e o que sobra entre elas é a rua. Foi por isso que o retângulo
 * ficou centrado em `z = -18,5` — ele precisa conter a travessa também.
 *
 * ## Por que as fachadas são escritas à mão
 *
 * `district()` e `skylineRing()` geram anéis, e um anel é o oposto de uma rua.
 * Aqui cada fatia tem largura e altura próprias porque a silhueta do corredor É
 * o desenho: uma torre no meio da fileira baixa é o que faz a rua ter fundo.
 */
const NOIR_STREET_HALF = 9;
/** A travessa é mais estreita, e é isso que faz dela outra rua e não um clone. */
const NOIR_LANE_HALF = 6.5;
/** Eixo da travessa em Z. A avenida fica em `z = 0`. */
const NOIR_LANE_Z = -39.5;

/**
 * Uma fileira de fachadas encaixada na fatia `[x0, x1]`.
 *
 * `frontZ` é a face que dá para a rua e `dir` é o lado para onde ela olha
 * (+1 = olha para +Z). O volume cresce para TRÁS a partir da frente — é o que
 * permite duas ruas paralelas encostarem os fundos uma na outra sem deixar uma
 * fresta andável entre elas, que é o defeito clássico de compor quarteirão com
 * caixas soltas.
 */
function noirRow(
  x0: number, x1: number, frontZ: number, dir: -1 | 1, depth: number,
  floors: number, style: BuildingPlacement['style'], seed: number,
): BuildingPlacement {
  return {
    x: (x0 + x1) / 2,
    z: frontZ - dir * (depth / 2),
    // As fachadas são autoradas olhando para +Z; quem olha para -Z leva meia
    // volta, senão mostra os fundos a quem anda na rua.
    ry: dir === 1 ? 0 : Math.PI,
    width: x1 - x0,
    depth,
    floors,
    style,
    seed,
  };
}

/** Fachada da avenida: a fileira norte (side -1) e a sul (side 1). */
function noirFacade(
  x0: number, x1: number, side: -1 | 1, floors: number, style: BuildingPlacement['style'], seed: number,
): BuildingPlacement {
  return noirRow(x0, x1, side * NOIR_STREET_HALF, side === -1 ? 1 : -1, 12, floors, style, seed);
}

/**
 * O beco sem saída, na fileira norte da avenida.
 *
 * `end` deixou de ser uma parede inventada: ele para no FUNDO dos prédios da
 * travessa (`z = -33 + 12 = -21`). Duas tabelas leem isto — as fachadas e o
 * colisor —, e uma terceira (a cena) usa `x1` para encostar a escada de
 * incêndio na parede certa.
 */
export const NOIR_ALLEY = { x0: 3.5, x1: 10.5, mouth: -NOIR_STREET_HALF, end: -21 } as const;

/** As duas passagens que ATRAVESSAM da avenida para a travessa. */
export const NOIR_PASSAGES = [
  { id: 'oeste', x0: -27, x1: -21 },
  { id: 'leste', x0: 30, x1: 36 },
] as const;

/**
 * Postes ao longo de uma rua, ALTERNADOS entre as calçadas.
 *
 * Em frente um ao outro, os cones de luz se somam no meio da rua e o corredor
 * fica uniformemente iluminado — que é o contrário de noir. Em ziguezague, cada
 * poço de luz tem escuro dos dois lados, e é entre eles que uma pessoa aparece
 * e some.
 */
function noirLamps(x0: number, x1: number, step: number, z: number, half: number): Placement[] {
  const out: Placement[] = [];
  for (let i = 0; x0 + i * step <= x1; i++) {
    const lado = i % 2 === 0 ? -1 : 1;
    out.push({ x: x0 + i * step, z: z + lado * (half - 1.2), ry: lado === -1 ? 0 : Math.PI });
  }
  return out;
}

export const NOIR = {
  /**
   * Meia-largura e meia-profundidade do retângulo andável, e o centro dele.
   *
   * Assimétrico em Z porque o bairro é: as duas ruas ficam ao NORTE do eixo da
   * avenida, e o retângulo tem de conter da calçada sul da avenida (`z = +9`)
   * até a calçada norte da travessa (`z = -46`).
   */
  bounds: { x: 0, z: -18.5, hw: 58, hd: 27.5 },
  streetHalf: NOIR_STREET_HALF,
  laneHalf: NOIR_LANE_HALF,
  laneZ: NOIR_LANE_Z,
  alley: NOIR_ALLEY,
  passages: NOIR_PASSAGES,

  /**
   * As ruas, como DADO.
   *
   * A cena desenhava uma avenida porque a avenida estava escrita nela: asfalto,
   * duas calçadas e uma faixa central, com números soltos no meio do código.
   * Com duas ruas isso viraria o mesmo bloco copiado — e a segunda cópia é
   * onde o eixo fica torto e ninguém percebe. Aqui a rua é uma linha de tabela
   * e a cena percorre a lista.
   */
  streets: [
    { id: 'avenida', z: 0, half: NOIR_STREET_HALF, x0: -58, x1: 58, dashes: true },
    // Sem faixa central: rua de serviço não é pintada, e a ausência da faixa é
    // metade do que faz a travessa parecer os fundos da avenida.
    { id: 'travessa', z: NOIR_LANE_Z, half: NOIR_LANE_HALF, x0: -40, x1: 40, dashes: false },
  ] as Array<{ id: string; z: number; half: number; x0: number; x1: number; dashes: boolean }>,

  /**
   * As quatro fileiras.
   *
   * A sul da avenida é contínua e a mais alta: é a que fica de frente para quem
   * chega, e uma parede alta do outro lado da rua é o que dá altura ao corredor
   * sem tapar o céu de quem anda nele. A norte é recortada pelas duas passagens
   * e pelo beco. As da travessa são deliberadamente mais baixas — ela é o
   * fundo do quarteirão, não uma segunda avenida.
   */
  facades: [
    // ---- avenida, fileira norte (recortada pelas passagens e pelo beco) ----
    noirFacade(-58, -46, -1, 5, 'townhouse', 801),
    noirFacade(-46, -34, -1, 7, 'modern', 802),
    noirFacade(-34, -27, -1, 4, 'townhouse', 803),
    /* passagem oeste: x ∈ [-27, -21] */
    noirFacade(-21, -9, -1, 7, 'modern', 804),
    noirFacade(-9, 3.5, -1, 5, 'townhouse', 805),
    /* beco sem saída: x ∈ [3.5, 10.5] */
    noirFacade(10.5, 22, -1, 9, 'tower', 806),
    noirFacade(22, 30, -1, 4, 'townhouse', 807),
    /* passagem leste: x ∈ [30, 36] */
    noirFacade(36, 48, -1, 6, 'modern', 808),
    noirFacade(48, 58, -1, 4, 'townhouse', 809),

    // ---- avenida, fileira sul (contínua) ----
    noirFacade(-58, -46, 1, 6, 'modern', 821),
    noirFacade(-46, -34, 1, 5, 'townhouse', 822),
    noirFacade(-34, -22, 1, 6, 'modern', 823),
    noirFacade(-22, -8, 1, 11, 'tower', 824),
    noirFacade(-8, 6, 1, 5, 'townhouse', 825),
    noirFacade(6, 20, 1, 8, 'modern', 826),
    noirFacade(20, 34, 1, 6, 'townhouse', 827),
    noirFacade(34, 46, 1, 9, 'tower', 828),
    noirFacade(46, 58, 1, 5, 'modern', 829),

    // ---- travessa, fileira sul: a MESMA massa que fecha o beco por trás ----
    // Frente em z = -33 olhando para a travessa; 12 m de fundo levam o volume
    // até z = -21, que é onde a fileira norte da avenida termina. Os dois
    // quarteirões encostam de costas e não sobra fresta.
    noirRow(-40, -27, -33, -1, 12, 4, 'townhouse', 841),
    /* passagem oeste atravessa aqui também */
    noirRow(-21, -6, -33, -1, 12, 5, 'modern', 842),
    noirRow(-6, 10, -33, -1, 12, 4, 'townhouse', 843),
    noirRow(10, 24, -33, -1, 12, 6, 'modern', 844),
    noirRow(24, 30, -33, -1, 12, 4, 'townhouse', 845),
    /* passagem leste */
    noirRow(36, 40, -33, -1, 12, 5, 'townhouse', 846),

    // ---- travessa, fileira norte ----
    noirRow(-40, -28, -46, 1, 10, 5, 'modern', 861),
    noirRow(-28, -14, -46, 1, 10, 3, 'townhouse', 862),
    noirRow(-14, 0, -46, 1, 10, 7, 'tower', 863),
    noirRow(0, 14, -46, 1, 10, 4, 'townhouse', 864),
    noirRow(14, 28, -46, 1, 10, 6, 'modern', 865),
    noirRow(28, 40, -46, 1, 10, 4, 'townhouse', 866),

    // ---- os dois quarteirões que fecham as pontas da travessa ----
    // Sem eles a faixa entre `z = -46` e `z = -21` continuaria andável além de
    // `x = ±40` — um vazio sem parede nem prédio, que é como um mundo revela
    // que a planta acabou antes do chão.
    { x: -49, z: -33.5, ry: 0, width: 18, depth: 25, floors: 6, style: 'modern', seed: 881 },
    { x: 49, z: -33.5, ry: 0, width: 18, depth: 25, floors: 5, style: 'townhouse', seed: 882 },
  ] as BuildingPlacement[],

  /**
   * A silhueta atrás das fileiras. Só desenho — o corredor termina nas
   * fachadas, e obstáculo que ninguém alcança é peso que o servidor carrega à
   * toa (a mesma regra de `PLAZA.districts`).
   */
  skyline: [
    skylineRing(20, 96, 0.2, 30, 78, 14, 26),
    skylineRing(18, 136, 0.9, 44, 104, 18, 32),
  ].flat(),

  /** Postes das duas ruas, na ordem em que se anda por elas (oeste → leste). */
  lamps: [
    ...noirLamps(-54, 54, 6.8, 0, NOIR_STREET_HALF),
    ...noirLamps(-36, 36, 8.0, NOIR_LANE_Z, NOIR_LANE_HALF),
  ] as Placement[],

  /**
   * Néons nas fachadas: a única cor saturada da cena (ver `LOOK_NOIR`).
   *
   * A ORDEM importa e não é estética: só os primeiros ganham luz pontual de
   * verdade (o resto continua aceso, porque a geometria é emissiva). Como se
   * chega pelo portão a oeste, a lista corre de oeste para leste — o orçamento
   * de luz cai onde o jogador está.
   */
  signs: [
    { x: -50.0, z: -NOIR_STREET_HALF + 0.15, y: 3.4, ry: 0, w: 3.4, h: 1.0, tint: 0xff2d55, text: 'bar' },
    { x: -51.0, z: NOIR_STREET_HALF - 0.15, y: 3.6, ry: Math.PI, w: 3.2, h: 0.9, tint: 0x2fd8ff, text: 'metro' },
    { x: -38.0, z: -NOIR_STREET_HALF + 0.15, y: 4.6, ry: 0, w: 2.2, h: 2.8, tint: 0xff2d55, text: 'hotel' },
    { x: -37.0, z: NOIR_STREET_HALF - 0.15, y: 6.0, ry: Math.PI, w: 2.0, h: 3.2, tint: 0xff2d55, text: 'torre' },
    { x: -14.0, z: -NOIR_STREET_HALF + 0.15, y: 3.1, ry: 0, w: 3.0, h: 0.8, tint: 0x2fd8ff, text: 'cafe' },
    { x: 2.0, z: NOIR_STREET_HALF - 0.15, y: 3.2, ry: Math.PI, w: 3.6, h: 1.0, tint: 0xff2d55, text: 'oficina' },
    { x: 16.0, z: -NOIR_STREET_HALF + 0.15, y: 5.2, ry: 0, w: 2.6, h: 1.2, tint: 0xff2d55, text: 'club' },
    { x: 26.0, z: NOIR_STREET_HALF - 0.15, y: 4.4, ry: Math.PI, w: 2.4, h: 1.1, tint: 0xffc23c, text: 'doca' },
    { x: 42.0, z: -NOIR_STREET_HALF + 0.15, y: 3.3, ry: 0, w: 2.8, h: 0.9, tint: 0xffc23c, text: 'loja' },
    { x: 52.0, z: NOIR_STREET_HALF - 0.15, y: 4.0, ry: Math.PI, w: 2.6, h: 1.0, tint: 0x2fd8ff, text: 'lava' },

    // O do beco fica de LADO, olhando para dentro dele: é a única luz lá.
    { x: NOIR_ALLEY.x0 + 0.15, z: -15, y: 3.0, ry: Math.PI / 2, w: 1.8, h: 0.7, tint: 0xff2d55, text: 'fundos' },

    // A travessa recebe três, e só três. Ela é o fundo do quarteirão: cheia de
    // néon deixaria de ser o lado escuro e viraria uma segunda avenida.
    { x: -22.0, z: NOIR_LANE_Z - NOIR_LANE_HALF + 0.15, y: 3.0, ry: 0, w: 2.6, h: 0.8, tint: 0xffc23c, text: 'deposito' },
    { x: 8.0, z: NOIR_LANE_Z + NOIR_LANE_HALF - 0.15, y: 3.4, ry: Math.PI, w: 2.2, h: 0.9, tint: 0x2fd8ff, text: 'garagem' },
    { x: 30.0, z: NOIR_LANE_Z - NOIR_LANE_HALF + 0.15, y: 2.9, ry: 0, w: 2.0, h: 0.7, tint: 0xff2d55, text: 'clinica' },
  ] as Array<{ x: number; z: number; y: number; ry: number; w: number; h: number; tint: number; text: string }>,

  /**
   * Poças. Desenho puro, e o motivo delas é o néon: um letreiro vermelho sobre
   * asfalto seco é um letreiro; sobre água parada, é o dobro da imagem.
   */
  puddles: [
    { x: -52.0, z: 2.4, ry: 0.3, s: 3.4 }, { x: -44.5, z: -4.0, ry: 1.1, s: 2.2 },
    { x: -36.0, z: 3.6, ry: 0.7, s: 4.1 }, { x: -28.5, z: -3.2, ry: 2.0, s: 2.6 },
    { x: -19.0, z: 4.2, ry: 0.4, s: 3.0 }, { x: -11.5, z: -2.6, ry: 1.6, s: 3.6 },
    { x: -3.0, z: 3.0, ry: 0.9, s: 2.4 }, { x: 5.5, z: -4.4, ry: 2.4, s: 3.2 },
    { x: 14.0, z: 3.4, ry: 0.2, s: 3.8 }, { x: 22.5, z: -3.0, ry: 1.3, s: 2.6 },
    { x: 31.0, z: 4.0, ry: 0.8, s: 3.2 }, { x: 40.5, z: -2.2, ry: 2.1, s: 2.8 },
    { x: 49.0, z: 3.2, ry: 0.5, s: 3.6 },
    // Beco e passagens: a água parada é o que diz que ali não bate sol.
    { x: 6.4, z: -14.0, ry: 0.5, s: 2.8 }, { x: 8.2, z: -18.5, ry: 1.9, s: 2.0 },
    { x: -24.2, z: -16.0, ry: 0.9, s: 2.4 }, { x: -23.4, z: -27.0, ry: 2.2, s: 2.0 },
    { x: 33.4, z: -18.0, ry: 1.2, s: 2.6 },
    // Travessa.
    { x: -30.0, z: NOIR_LANE_Z + 2.2, ry: 0.6, s: 3.0 },
    { x: -12.0, z: NOIR_LANE_Z - 2.6, ry: 1.8, s: 2.4 },
    { x: 6.0, z: NOIR_LANE_Z + 1.8, ry: 0.4, s: 3.4 },
    { x: 24.0, z: NOIR_LANE_Z - 2.0, ry: 2.5, s: 2.6 },
  ] as Placement[],

  /** Lixeiras e tambores. Quase todos no beco e na travessa: são os fundos. */
  bins: [
    { x: 4.6, z: -13.2, ry: 0.1 }, { x: 9.4, z: -16.8, ry: 1.4 },
    { x: 4.9, z: -19.4, ry: 0.3 }, { x: 9.2, z: -19.9, ry: 2.1 },
    { x: -24.6, z: -13.0, ry: 0.7 }, { x: -22.4, z: -24.0, ry: 1.9 },
    { x: 31.4, z: -14.4, ry: 0.2 }, { x: 34.6, z: -24.6, ry: 1.1 },
    { x: -45.0, z: -7.4, ry: 0 }, { x: 11.6, z: 7.2, ry: Math.PI },
    { x: -33.0, z: NOIR_LANE_Z - 5.0, ry: 0.4 }, { x: -8.0, z: NOIR_LANE_Z + 5.2, ry: 1.6 },
    { x: 17.0, z: NOIR_LANE_Z - 5.1, ry: 2.3 }, { x: 33.0, z: NOIR_LANE_Z + 5.0, ry: 0.9 },
  ] as Placement[],

  /** Contêineres de lixo: volume de peito, e é onde se esconde da rua. */
  dumpsters: [
    { x: 9.0, z: -19.0, ry: 0.06 },
    { x: 8.6, z: -11.6, ry: Math.PI / 2 + 0.1 },
    // Nas passagens eles ficam ENCOSTADOS na parede, não no meio: a passagem é
    // parada de bico (`stops.passagem_o` / `passagem_l`) e um contêiner no eixo
    // dela poria o destino dentro de um obstáculo.
    { x: -25.9, z: -16.0, ry: Math.PI / 2 + 0.04 },
    { x: 34.9, z: -17.0, ry: Math.PI / 2 + 0.05 },
    { x: 21.0, z: NOIR_LANE_Z + 4.9, ry: 0.1 },
    { x: -26.0, z: NOIR_LANE_Z - 4.8, ry: Math.PI + 0.1 },
  ] as Placement[],

  /** O tambor aceso do beco — a fogueira é a segunda fonte de luz da cena. */
  barrel: { x: 5.4, z: -18.2 },

  /**
   * O telão do bairro, na fachada sul da avenida.
   *
   * Todo ambiente do jogo tem uma tela, e esta é a do Distrito Sombra. Ela é
   * alta (base a 6 m) e presa na parede, não de chão: uma tela plantada na
   * calçada numa rua de 18 m viraria obstáculo no meio do caminho, e o bairro
   * é sobre atravessar.
   *
   * Fica num vão entre letreiros (os da fileira sul estão em x = -51, -37, 2,
   * 26 e 52), de frente para quem anda na avenida. E é o único painel do jogo
   * que a gradação vai desbotar: o `LOOK_NOIR` preserva só uma janela de
   * matiz, então o vídeo aparece aqui em preto e branco com o vermelho vivo —
   * o que é exatamente o que a cena faz com todo o resto.
   */
  screen: { x: 14, z: NOIR_STREET_HALF - 0.2, ry: Math.PI, width: 10, height: 5.6, base: 6.0 },

  /**
   * As PARADAS dos bicos (`gigs.ts`).
   *
   * Ficam aqui, com o resto da planta, pelo mesmo motivo dos colisores: quem
   * decide que alguém chegou numa parada é o game server, e ele lê esta tabela.
   * Uma lista de endereços escrita no catálogo de bicos e outra na cena
   * divergiria na primeira vez que alguém mexesse numa fachada.
   *
   * Com o bairro em duas ruas elas deixaram de caber todas num olhar — e é
   * disso que uma entrega precisava para ser uma entrega e não um passo.
   */
  stops: {
    portao:   { x: -54.5, z: 0, label: 'Portão do bairro' },
    bar:      { x: -50.0, z: -6.4, label: 'Bar da esquina' },
    metro:    { x: -51.0, z: 6.4, label: 'Boca do metrô' },
    hotel:    { x: -38.0, z: -6.6, label: 'Portaria do hotel' },
    cafe:     { x: -14.0, z: -6.5, label: 'Café da avenida' },
    oficina:  { x: 2.0, z: 6.5, label: 'Oficina' },
    club:     { x: 16.0, z: -6.6, label: 'Fila do clube' },
    doca:     { x: 26.0, z: 6.6, label: 'Doca de carga' },
    loja:     { x: 42.0, z: -6.4, label: 'Loja de conveniência' },
    lavanderia: { x: 52.0, z: 6.4, label: 'Lavanderia 24h' },
    fundos:   { x: 6.6, z: -15.4, label: 'Fundos do beco' },
    // As duas passagens são parada, e não só caminho: é o que obriga a rota a
    // trocar de rua em vez de correr sempre pela avenida.
    passagem_o: { x: -24.0, z: -21.0, label: 'Passagem oeste' },
    passagem_l: { x: 33.0, z: -21.0, label: 'Passagem leste' },
    deposito: { x: -22.0, z: NOIR_LANE_Z - 4.2, label: 'Depósito da travessa' },
    garagem:  { x: 8.0, z: NOIR_LANE_Z + 4.2, label: 'Garagem' },
    clinica:  { x: 30.0, z: NOIR_LANE_Z - 4.2, label: 'Clínica noturna' },
  } as Record<string, { x: number; z: number; label: string }>,

  /**
   * Figurantes. Menos que na praça e parados quase todos: uma rua de madrugada
   * cheia de gente andando lê como calçadão de domingo. Quem está aqui está
   * esperando alguma coisa.
   *
   * Com duas ruas eles ganharam uma função a mais: quem está na travessa é o
   * que prova, de dentro da passagem, que lá atrás existe alguém.
   */
  crowd: [
    { kind: 'walk', path: [{ x: -50, z: 4.2 }, { x: -32, z: 5.0, wait: 3.0 }, { x: -14, z: 3.4 }, { x: 4, z: 4.6 }] },
    { kind: 'walk', path: [{ x: 52, z: -4.4 }, { x: 34, z: -5.2, wait: 2.4 }, { x: 16, z: -4.0 }, { x: -2, z: -5.4 }] },
    { kind: 'walk', path: [{ x: -34, z: NOIR_LANE_Z + 3.2 }, { x: -10, z: NOIR_LANE_Z + 2.4, wait: 4.0 }, { x: 18, z: NOIR_LANE_Z + 3.6 }] },
    { kind: 'talk', path: [{ x: -50.8, z: -6.0 }], facing: Math.PI - 0.3 },
    { kind: 'talk', path: [{ x: -49.4, z: -6.2 }], facing: -0.3 },
    { kind: 'watch', path: [{ x: 15.4, z: -6.8 }], facing: 0.1 },
    { kind: 'watch', path: [{ x: 16.8, z: -7.0 }], facing: 0.15 },
    { kind: 'watch', path: [{ x: 41.4, z: -6.9 }], facing: 0.1 },
    // Um sozinho no beco, de frente para o tambor aceso.
    { kind: 'watch', path: [{ x: 6.6, z: -17.2 }], facing: Math.PI * 1.3 },
    // E um na boca de cada passagem: é o que faz o atalho parecer usado.
    { kind: 'watch', path: [{ x: -24.2, z: -11.0 }], facing: Math.PI },
    { kind: 'talk', path: [{ x: 33.0, z: -12.4 }], facing: 0.2 },
    { kind: 'talk', path: [{ x: 29.6, z: NOIR_LANE_Z - 4.0 }], facing: -0.2 },
  ] as CrowdRoutine[],
} as const;
