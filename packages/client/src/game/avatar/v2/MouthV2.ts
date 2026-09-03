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
/**
 * Quanto os cantos sobem, em alturas de traço.
 *
 * NEUTRA quer dizer neutra: um traço reto lê como aborrecido e um sorriso lê
 * como uma expressão que o jogador não escolheu. O que se quer é o repouso —
 * uma curva pequena o bastante para não ser um sorriso, grande o bastante para
 * a boca não parecer um risco de régua.
 */
const CURVE = 0.55;
/** Quanto o traço afina nos cantos, em fração da altura. */
const TAPER = 0.45;

/** Em quantos blocos o traço é cortado. Ímpar, para haver um bloco no meio. */
const SEGMENTS = 7;

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

  /**
   * @param frame o rosto descoberto pelo `FaceV2` — sem ele não há onde pôr boca.
   * @param head o osso `Head` do esqueleto DESTE avatar, que é quem a carrega.
   * @param skin o tom de pele do jogador, de onde sai a cor.
   */
  constructor(frame: FaceFrame, head: THREE.Bone, skin: THREE.ColorRepresentation) {
    const geometry = buildMouth(frame);
    const material = new THREE.MeshStandardMaterial({
      color: mouthColor(skin),
      roughness: 0.62,
      metalness: 0,
      // Chapado como o resto do pacote: estas cabeças são de faces planas, e uma
      // boca com sombreamento suave seria a única peça macia de um rosto duro.
      flatShading: true,
    });
    material.color.convertSRGBToLinear();

    const mesh = new THREE.Mesh(geometry, material);
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
    this.geometry = geometry;
    this.material = material;
    this.head = head;
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
      centro: centre.toArray().map((v) => +v.toFixed(5)),
      tamanho: size.toArray().map((v) => +v.toFixed(5)),
      blocos: SEGMENTS,
    };
  }

  dispose(): void {
    if (this.mesh) this.head.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.mesh = null;
  }
}

/**
 * O traço, em blocos, no espaço da cabeça.
 *
 * Blocos e não um tubo curvo pelo mesmo motivo que o olho do pacote é um cubo:
 * o rosto inteiro é de faces planas e poucos polígonos, e uma boca redonda
 * seria a peça mais detalhada de uma cabeça que não tem detalhe nenhum. Os
 * blocos das pontas sobem e afinam, e é essa escadinha que vira uma curva a
 * qualquer distância a que o rosto é olhado.
 */
function buildMouth(frame: FaceFrame): THREE.BufferGeometry {
  const width = frame.span * WIDTH;
  const thick = frame.span * THICK;
  const depth = frame.span * DEPTH;
  const rise = thick * CURVE;

  const midSide = frame.eyes.getComponent(frame.side);
  const midUp = frame.eyes.getComponent(frame.up) - frame.span * DROP;
  // A frente do traço fica no MESMO plano da frente do olho — o plano que o
  // próprio pacote usa para pôr uma peça na cara sem que ela afunde. Ali a
  // boca sobra dois milímetros da pele nos rostos masculinos e cinco nos
  // femininos, que é a mesma ordem de grandeza com que o olho sobra. Recuar
  // deste plano foi a primeira tentativa, e ela ENTERRAVA o meio da boca: a
  // pele abaixo do nariz está a apenas 0,00002 dele. O resto do bloco entra
  // pelo crânio adentro, onde ninguém o vê.
  const midFwd = frame.front - frame.facing * (depth / 2);

  const step = width / SEGMENTS;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    // -1 na ponta esquerda, +1 na direita.
    const t = (i - (SEGMENTS - 1) / 2) / ((SEGMENTS - 1) / 2);
    const away = Math.abs(t);
    const box = new THREE.BoxGeometry(
      // Uma folga entre os blocos deixaria a boca tracejada; um décimo de
      // sobreposição fecha a emenda sem engordar o traço.
      step * 1.1,
      thick * (1 - TAPER * away * away),
      depth,
    );
    const at = [0, 0, 0];
    const side = t * (width / 2 - step / 2);
    at[frame.side] = midSide + side;
    at[frame.up] = midUp + rise * away * away;
    // O canto acompanha a bochecha para trás, senão a boca fica reta num rosto
    // que não é.
    at[frame.forward] = midFwd - frame.facing * WRAP * Math.abs(side);
    box.translate(at[0], at[1], at[2]);
    parts.push(box);
  }

  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('MouthV2: falha ao juntar os blocos da boca');
  merged.computeBoundingSphere();
  return merged;
}
