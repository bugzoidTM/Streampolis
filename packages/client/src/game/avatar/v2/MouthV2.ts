import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FaceFrame } from './FaceV2.js';

/**
 * A boca do corpo de pacote.
 *
 * As 21 cabeças do pacote têm olho e sobrancelha como geometria própria e **não
 * têm boca nenhuma**: o rosto inteiro, abaixo dos olhos, é pele lisa. De longe
 * isso passa; num jogo de live, em que o rosto fica em cena por horas e o card
 * da loja é um busto, o que se vê é um manequim de olhos vivos e cara em
 * branco. Esta classe põe ali uma boca — uma só, neutra, fechada.
 *
 * ## Por que uma malha nova, e não uma deformação
 *
 * `FaceV2` faz o olho piscar mexendo em vértices que JÁ EXISTEM. Para a boca não
 * há o que mexer: não existe vértice de boca em cabeça nenhuma do pacote. Então
 * ela é geometria nova, e a decisão que vem junto é onde pendurá-la — no OSSO
 * `Head`, e não na malha da cabeça. Preso ao osso, o rosto leva a boca em toda
 * animação sem uma linha de código por quadro; costurada na malha, ela pediria
 * peso de pele, e peso de pele numa geometria que o pacote não tem é justamente
 * o tipo de coisa que sai errada em uma cabeça em vinte e uma.
 *
 * ## De onde saem as medidas
 *
 * De lugar nenhum que este arquivo tenha inventado: tudo vem do `FaceFrame` que
 * o `FaceV2` já descobriu ao procurar os olhos — quais eixos são cima, lado e
 * frente, para que lado o rosto olha, onde está a linha dos olhos, a aresta de
 * um olho e o vão entre eles. As proporções abaixo são frações dessas duas
 * réguas, e é isso que faz a mesma boca servir a cabeças de tamanhos diferentes
 * sem uma tabela por personagem.
 *
 * O espaço é o ESPAÇO DA CABEÇA (a inversa de bind do osso), o mesmo do
 * `FaceV2`, e nele as coordenadas são minúsculas — a linha dos olhos fica a
 * 0,001 do osso. Nada aqui pode ser escrito em metros: um número absoluto
 * plausível seria mil vezes o rosto inteiro.
 */

/**
 * As proporções, todas em VÃOS ENTRE OS OLHOS.
 *
 * O vão é a régua porque é a única medida do rosto que não muda entre as duas
 * famílias de cabeça do pacote: as onze masculinas têm o olho a 0,00024 de
 * aresta e as dez femininas a 0,00030, mas o vão entre os olhos é 0,00090 nas
 * vinte e uma. Medir a boca em arestas de olho daria duas bocas de tamanhos
 * diferentes em rostos do mesmo tamanho.
 *
 * Os números saíram de MEDIR as cabeças, não de estimar: um feixe de raios
 * varrendo o rosto em espaço da cabeça devolve, para cada altura, onde está a
 * pele. Foi ele que disse onde o nariz acaba (0,00053 nos homens, 0,00040 nas
 * mulheres, contra a linha dos olhos em 0,00105) e a que altura a parede do
 * rosto vira bochecha. Amostrar VÉRTICES não serviria: numa cabeça de poucos
 * polígonos a face abaixo do nariz é um quadrilátero só, e no meio dele — que é
 * exatamente onde a boca vai — não há vértice nenhum.
 */

/** Abaixo da linha dos olhos. 0,85 põe a boca entre a base do nariz e o queixo. */
const DROP = 0.85;
/** Largura do traço. Além de 0,6 os cantos passam da parede do rosto e viram bochecha. */
const WIDTH = 0.58;
/** Altura do traço. Um lábio fechado é uma linha, não uma faixa. */
const THICK = 0.085;
/** Profundidade do bloco: ele afunda no crânio, e só a frente aparece. */
const DEPTH = 0.15;
/**
 * Quanto os cantos acompanham a curva do rosto, em recuo por unidade de lado.
 *
 * A parede do rosto não é plana: da linha média até o canto da boca ela recua
 * 0,00007 nas cabeças masculinas e 0,000035 nas femininas. Sem acompanhar isso,
 * o canto do traço fica a seis milímetros da bochecha e a boca parece colada
 * por fora; acompanhando demais, ele afunda e a boca vira um risco curto no
 * meio do rosto. Vinte centésimos deixam os dois rostos com o mesmo palmo de
 * folga no canto.
 */
const WRAP = 0.20;
/** Em quantos blocos o traço é cortado. Ímpar, para haver um bloco no meio. */
const SEGMENTS = 9;

/**
 * ONDE a boca está, para quem precisa pintar em volta dela.
 *
 * Publicado porque a alternativa é a pele repetir as mesmas frações e as duas
 * contas envelhecerem separadas: mover a boca meio milímetro deixaria o lábio
 * pintado onde a boca não está mais. Quem manda na posição da boca é este
 * arquivo, e quem quiser desenhar em volta pergunta.
 */
export function mouthAnchor(frame: FaceFrame): {
  side: number; up: number; forward: number; halfWidth: number; halfHeight: number;
} {
  return {
    side: frame.eyes.getComponent(frame.side),
    up: frame.eyes.getComponent(frame.up) - frame.span * DROP,
    forward: frame.front,
    halfWidth: (frame.span * WIDTH) / 2,
    halfHeight: (frame.span * THICK) / 2,
  };
}

/**
 * A FORMA da boca, em quatro números — e é só isto que um estado é.
 *
 * Guardar quatro geometrias e trocar entre elas seria o caminho óbvio e o
 * errado: a troca ficaria seca (um quadro fechada, o seguinte escancarada) e
 * cada avatar carregaria quatro buffers para usar um. Aqui a geometria é uma
 * só, os quatro números são o que se interpola, e a boca ATRAVESSA de uma forma
 * à outra — que é o que uma boca faz.
 *
 * Todos são frações da altura do traço neutro, e por isso valem em qualquer
 * cabeça: quem dá a escala é sempre o vão entre os olhos.
 */
interface MouthShape {
  /** Multiplica a largura. Uma boca surpresa é mais estreita que uma fechada. */
  width: number;
  /** Multiplica a espessura do traço. */
  thick: number;
  /**
   * Curvatura dos cantos, em alturas de traço. Positivo levanta (sorriso),
   * negativo derruba (tristeza). É uma parábola, não um levantamento de ponta:
   * o que lê como sorriso é a LINHA inteira curvar.
   */
  curve: number;
  /** Abertura no meio, em alturas de traço. É o que separa um traço de uma boca aberta. */
  open: number;
  /** Afinamento dos cantos, em fração da altura. */
  taper: number;
}

export type MouthState = 'neutral' | 'smile' | 'surprise' | 'sad';

/**
 * As quatro formas.
 *
 * Números pequenos, e de propósito: este rosto tem duas barras pretas de olho e
 * um traço de boca, e é dessa contenção que ele tira a expressão. Um sorriso de
 * orelha a orelha num rosto de poucos polígonos não lê como alegria — lê como
 * defeito de malha.
 *
 * `neutral` é exatamente a boca que existia antes dos estados: mesma largura,
 * mesma espessura, mesma curva de repouso. Trocar de estado e voltar tem de
 * devolver o rosto ao lugar de onde ele saiu, e um `neutral` "melhorado" seria
 * uma expressão permanente que ninguém pediu.
 */
const SHAPES: Record<MouthState, MouthShape> = {
  neutral: { width: 1.00, thick: 1.00, curve: 0.55, open: 0.00, taper: 0.45 },
  // O sorriso curva a linha e abre um fio: boca fechada demais com os cantos
  // para cima lê como quem está segurando o riso, não como quem está rindo.
  smile: { width: 1.08, thick: 0.95, curve: 2.60, open: 0.45, taper: 0.55 },
  // O "O". Estreita para não virar um bocejo, e a abertura é o número grande —
  // é ela que faz a surpresa ser lida a três metros de distância.
  surprise: { width: 0.64, thick: 1.00, curve: 0.00, open: 3.00, taper: 0.00 },
  // A tristeza é o sorriso ao contrário e MENOS forte: um rosto de canto muito
  // caído vira caricatura de choro. O traço também encolhe um pouco, que é o
  // que dá o aperto de lábio.
  sad: { width: 0.92, thick: 1.00, curve: -1.50, open: 0.00, taper: 0.50 },
};

/**
 * Para onde a boca cresce ao abrir: quase tudo para BAIXO.
 *
 * O lábio de cima é preso ao crânio e o de baixo é que desce — abrir em torno
 * do centro sobe a boca até a base do nariz, e o rosto fica com cara de focinho.
 */
const OPEN_DOWN = 0.72;

/** Meia-vida da troca de estado, em segundos. Boca não muda de forma em salto. */
const MORPH_HALFLIFE = 0.055;

/**
 * A FALA, em três números.
 *
 * Falar não é um quinto estado: é uma modulação POR CIMA do estado em que a
 * boca está. Quem fala sorrindo continua sorrindo, e quando a fala acaba a boca
 * volta para onde estava sem que ninguém precise se lembrar de onde era.
 *
 * A cadência é de sílaba, não de fonema: 4,2 por segundo é a taxa silábica do
 * português falado, e é o que separa uma boca que fala de uma boca que treme.
 * A segunda onda, lenta e fora de fase, é o que impede a fala de virar
 * metrônomo — sem ela quinze avatares conversando na praça abrem a boca no
 * mesmo compasso.
 */
const TALK_HZ = 4.2;
const TALK_SWING_HZ = 1.7;
/** Quanto a fala abre, em alturas de traço. Menos que a surpresa, de propósito. */
const TALK_OPEN = 1.5;
/** Sobe e desce da fala, em segundos: começar e terminar de boca escancarada é caretice. */
const TALK_FADE = 0.14;

/**
 * A cor da boca, derivada do TOM DE PELE.
 *
 * Uma cor fixa vale para uma pele só: o mesmo bordô que lê como boca numa pele
 * clara vira uma mancha preta numa pele escura, e um rosa fixo numa pele escura
 * lê como maquiagem. Escurecer e avermelhar a própria pele do jogador é o que
 * mantém a boca como sombra da pele em qualquer um dos oito tons.
 */
function mouthColor(skin: THREE.ColorRepresentation): THREE.Color {
  const c = new THREE.Color(skin);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return new THREE.Color().setHSL(
    hsl.h * 0.55,
    Math.min(1, hsl.s * 0.9 + 0.12),
    Math.max(0.06, hsl.l * 0.42),
  );
}

export class MouthV2 {
  /** Some no `dispose`; enquanto existe, está pendurada no osso da cabeça. */
  private mesh: THREE.Mesh | null;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly head: THREE.Bone;
  private readonly frame: FaceFrame;
  /**
   * De que bloco e de que canto dele veio cada vértice.
   *
   * Três bytes por vértice — o índice do bloco e os três sinais do canto — e é
   * com isso que a forma é recalculada: a posição de um vértice é uma FUNÇÃO do
   * bloco a que ele pertence, e não um dado a ser deformado. É o que permite
   * abrir a boca sem que a geometria se lembre de como ela era fechada.
   */
  private readonly bloco: Int8Array;
  private readonly canto: Int8Array;

  private alvo: MouthShape = SHAPES.neutral;
  private atual: MouthShape = { ...SHAPES.neutral };
  private estado: MouthState = 'neutral';
  /** Falso quando `atual` já é `alvo`: aí não há o que reescrever por quadro. */
  private mexendo = false;
  /** Relógio próprio, em segundos. A fala precisa de um, o estado não. */
  private clock = 0;
  /** Quando a fala acaba, no relógio acima. Zero é boca calada. */
  private falaAte = 0;
  private falaDe = 0;
  /** Fase da fala deste avatar. Ver `speak`. */
  private falaSeed = 0;

  /**
   * @param frame o rosto descoberto pelo `FaceV2` — sem ele não há onde pôr boca.
   * @param head o osso `Head` do esqueleto DESTE avatar, que é quem a carrega.
   * @param skin o tom de pele do jogador, de onde sai a cor.
   */
  constructor(frame: FaceFrame, head: THREE.Bone, skin: THREE.ColorRepresentation) {
    this.frame = frame;
    const built = buildMouth();
    this.geometry = built.geometry;
    this.bloco = built.bloco;
    this.canto = built.canto;
    this.write(this.atual);

    const material = new THREE.MeshStandardMaterial({
      color: mouthColor(skin),
      roughness: 0.62,
      metalness: 0,
      // Chapado como o resto do pacote: estas cabeças são de faces planas, e uma
      // boca com sombreamento suave seria a única peça macia de um rosto duro.
      flatShading: true,
    });
    material.color.convertSRGBToLinear();

    const mesh = new THREE.Mesh(this.geometry, material);
    // Um traço de meio centímetro não projeta sombra em nada, e o mapa de
    // sombras é caro. Receber, sim: sem isso a boca ignora a luz do ambiente e
    // fica acesa num rosto na penumbra.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // O osso da cabeça leva a boca para longe da caixa de repouso dela em
    // qualquer gesto; culada, ela pisca fora da tela no meio de uma dança.
    mesh.frustumCulled = false;
    mesh.name = 'MouthV2';
    head.add(mesh);

    this.mesh = mesh;
    this.material = material;
    this.head = head;
  }

  get state(): MouthState {
    return this.estado;
  }

  /**
   * Pede uma forma. A boca ATRAVESSA até ela; não salta.
   *
   * Pedir o estado em que já se está é no-op de verdade — e isso importa:
   * quem chama é o laço do jogo, todo quadro, e recalcular 216 vértices por
   * avatar por quadro para escrever o mesmo número é o tipo de desperdício que
   * só aparece com trinta pessoas na praça.
   */
  setState(state: MouthState): void {
    if (state === this.estado) return;
    this.estado = state;
    this.alvo = SHAPES[state];
    this.mexendo = true;
  }

  /**
   * Põe a boca a falar por `seconds`, com uma fase própria.
   *
   * A fase vem de FORA — do id da mensagem — e não de `Math.random`: é o que
   * faz duas abas do mesmo jogador desenharem a mesma fala, e o que impede a
   * praça inteira de abrir a boca no mesmo quadro. Não há protocolo novo nisto;
   * o id já vem na mensagem de chat que todo mundo recebeu.
   */
  speak(seconds: number, seed = 0): void {
    this.falaDe = this.clock;
    this.falaAte = this.clock + Math.max(0, seconds);
    this.falaSeed = seed;
  }

  get speaking(): boolean {
    return this.clock < this.falaAte;
  }

  /** Avança a travessia e a fala. Barato quando não há nem uma nem outra. */
  update(dt: number): void {
    if (!this.mesh) return;
    this.clock += dt;
    const falando = this.clock < this.falaAte;
    if (!this.mexendo && !falando && !this.limpando) return;

    if (this.mexendo) {
      const k = 1 - Math.pow(2, -dt / MORPH_HALFLIFE);
      let longe = 0;
      for (const campo of ['width', 'thick', 'curve', 'open', 'taper'] as const) {
        const d = this.alvo[campo] - this.atual[campo];
        this.atual[campo] += d * k;
        longe = Math.max(longe, Math.abs(this.alvo[campo] - this.atual[campo]));
      }
      // Encostou: escreve a forma EXATA e para. Sem este fecho a boca fica
      // eternamente a um milésimo do destino, reescrevendo a geometria para
      // sempre — o custo de uma expressão que já acabou.
      if (longe < 0.002) {
        this.atual = { ...this.alvo };
        this.mexendo = false;
      }
    }

    // A fala é somada por cima da forma corrente, e some com ela. `limpando`
    // existe para o QUADRO SEGUINTE ao fim da fala: sem ele a boca pararia na
    // última abertura desenhada e ficaria entreaberta para sempre.
    this.limpando = falando;
    this.write(falando ? this.falando(this.atual) : this.atual);
  }

  private limpando = false;

  /** A forma corrente com a boca aberta na sílaba em que a fala está. */
  private falando(shape: MouthShape): MouthShape {
    const t = this.clock;
    const desde = t - this.falaDe;
    const ate = this.falaAte - t;
    // Sobe e desce nas pontas: a fala começa e termina de boca fechada.
    const env = Math.min(1, desde / TALK_FADE, Math.max(0, ate / TALK_FADE));
    const silaba = 0.5 - 0.5 * Math.cos(t * Math.PI * 2 * TALK_HZ + this.falaSeed);
    const balanco = 0.65 + 0.35 * Math.sin(t * Math.PI * 2 * TALK_SWING_HZ + this.falaSeed * 1.7);
    const abre = TALK_OPEN * env * silaba * balanco;
    return {
      ...shape,
      open: shape.open + abre,
      // Boca aberta é boca mais estreita: sem isto a fala parece um bocejo
      // retangular.
      width: shape.width * (1 - 0.10 * Math.min(1, abre / TALK_OPEN)),
    };
  }

  /** Onde a boca ficou, para quem precisa provar que ela existe e está no rosto. */
  describe(): Record<string, unknown> | null {
    if (!this.mesh) return null;
    const box = new THREE.Box3().setFromBufferAttribute(
      this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    return {
      estado: this.estado,
      centro: centre.toArray().map((v) => +v.toFixed(5)),
      tamanho: size.toArray().map((v) => +v.toFixed(5)),
      blocos: SEGMENTS,
      // Quanto os CANTOS estão acima do meio, em alturas de traço. É o número
      // que separa um sorriso de uma tristeza — a caixa envolvente não separa,
      // porque as duas curvam a mesma linha para lados opostos e ocupam a mesma
      // caixa. Positivo é sorriso, negativo é tristeza.
      cantos: +(this.cornerLift() / (this.frame.span * THICK)).toFixed(3),
    };
  }

  /** Altura média dos dois blocos das pontas menos a do bloco do meio. */
  private cornerLift(): number {
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const eixo = this.frame.up;
    let pontas = 0;
    let pontasN = 0;
    let meio = 0;
    let meioN = 0;
    const middle = (SEGMENTS - 1) / 2;
    for (let v = 0; v < pos.count; v++) {
      const i = this.bloco[v] as number;
      const y = eixo === 0 ? pos.getX(v) : eixo === 1 ? pos.getY(v) : pos.getZ(v);
      if (i === 0 || i === SEGMENTS - 1) { pontas += y; pontasN++; } else if (i === middle) { meio += y; meioN++; }
    }
    if (!pontasN || !meioN) return 0;
    return pontas / pontasN - meio / meioN;
  }

  dispose(): void {
    if (this.mesh) this.head.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh = null;
  }

  /**
   * Escreve a forma na geometria, em espaço da cabeça.
   *
   * Cada vértice é recalculado do zero a partir do bloco a que pertence — nada
   * é deformado a partir do estado anterior, porque deformar acumula erro e uma
   * boca que abre e fecha mil vezes numa sessão acabaria torta.
   */
  private write(shape: MouthShape): void {
    const f = this.frame;
    const width = f.span * WIDTH * shape.width;
    const thick = f.span * THICK * shape.thick;
    const base = f.span * THICK;
    const depth = f.span * DEPTH;
    const step = width / SEGMENTS;

    const midSide = f.eyes.getComponent(f.side);
    const midUp = f.eyes.getComponent(f.up) - f.span * DROP;
    // A frente do traço fica no MESMO plano da frente do olho — o plano que o
    // próprio pacote usa para pôr uma peça na cara sem que ela afunde. Ali a
    // boca sobra dois milímetros da pele nos rostos masculinos e cinco nos
    // femininos, que é a mesma ordem de grandeza com que o olho sobra. Recuar
    // deste plano foi a primeira tentativa, e ela ENTERRAVA o meio da boca: a
    // pele abaixo do nariz está a apenas 0,00002 dele.
    const midFwd = f.front - f.facing * (depth / 2);

    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out = [0, 0, 0];
    for (let v = 0; v < pos.count; v++) {
      const i = this.bloco[v] as number;
      const t = (i - (SEGMENTS - 1) / 2) / ((SEGMENTS - 1) / 2);
      const away = Math.abs(t);
      const side = t * (width / 2 - step / 2);
      // Altura do bloco: afinando para os cantos e engordando no meio quando a
      // boca abre. O `max` é o que faz a abertura ser um bojo central e não um
      // retângulo — uma boca aberta é redonda.
      // Meia-elipse, e não parábola: a parábola afina cedo demais e a boca
      // aberta vira um V. O que se quer é um O — cheio no meio e fechando só
      // perto do canto.
      const alta = thick * (1 - shape.taper * away * away)
        + shape.open * base * Math.sqrt(Math.max(0, 1 - away * away));
      // A curva da linha, e a queda do centro conforme ela abre.
      const lift = shape.curve * base * away * away;
      const up = midUp + lift - (alta - thick) * OPEN_DOWN * 0.5;

      out[f.side] = midSide + side + (this.canto[v * 3] as number) * (step * 0.55);
      out[f.up] = up + (this.canto[v * 3 + 1] as number) * (alta / 2);
      // O canto acompanha a bochecha para trás, senão a boca fica reta num rosto
      // que não é.
      out[f.forward] = midFwd - f.facing * WRAP * Math.abs(side)
        + (this.canto[v * 3 + 2] as number) * (depth / 2);
      pos.setXYZ(v, out[0], out[1], out[2]);
    }
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
  }
}

/**
 * O traço, em blocos, e a etiqueta de cada vértice.
 *
 * Blocos e não um tubo curvo pelo mesmo motivo que o olho do pacote é um cubo:
 * o rosto inteiro é de faces planas e poucos polígonos, e uma boca redonda
 * seria a peça mais detalhada de uma cabeça que não tem detalhe nenhum. Nove
 * blocos, e não sete, porque agora eles precisam desenhar também um "O": com
 * sete, a boca aberta tem quatro degraus de cada lado e lê como escada.
 *
 * A geometria nasce em torno da origem e sem tamanho nenhum — quem dá posição e
 * forma a ela é `write`, e por isso a mesma malha serve às quatro expressões.
 */
function buildMouth(): { geometry: THREE.BufferGeometry; bloco: Int8Array; canto: Int8Array } {
  const parts: THREE.BufferGeometry[] = [];
  const bloco: number[] = [];
  const canto: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    const box = new THREE.BoxGeometry(2, 2, 2);
    const pos = box.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      bloco.push(i);
      // O canto de um cubo de aresta 2 é (±1, ±1, ±1): o sinal é a etiqueta.
      canto.push(Math.sign(pos.getX(v)), Math.sign(pos.getY(v)), Math.sign(pos.getZ(v)));
    }
    parts.push(box);
  }
  const geometry = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!geometry) throw new Error('MouthV2: falha ao juntar os blocos da boca');
  return { geometry, bloco: Int8Array.from(bloco), canto: Int8Array.from(canto) };
}
