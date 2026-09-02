import * as THREE from 'three';
import { Reflex } from '../Reflex.js';

/**
 * O rosto vivo do corpo de pacote.
 *
 * A migração v2 trocou um rosto que ninguém achou bonito, mas que piscava,
 * movia o olhar e tinha quatro expressões, por um rosto que as pessoas aceitam
 * e que estava **morto**: uma malha do pacote, de olho arregalado, para sempre.
 * Num jogo de live o rosto fica em cena por horas, e a essa distância a
 * diferença entre um personagem e um manequim é piscar.
 *
 * O pacote não dá pálpebra. O que ele dá, e é o suficiente, é **o olho como
 * geometria própria**: em cada uma das 21 cabeças o par de olhos são dois cubos
 * de 24 vértices, simétricos em torno do zero, e — isto é o que torna tudo
 * exato — **100% pesados no osso `Head`**, sem um único vértice dividido com a
 * pele. Para esses vértices a deformação é uma transformação rígida: escrever
 * na pose de bind produz depois do skinning exatamente o que se calculou, sem
 * correção nenhuma.
 *
 * O olho ainda ESPETA uns 5 milésimos à frente da pele. É por isso que fechar é
 * achatar em Y e não mexer em Z: a face frontal do cubo continua na frente do
 * rosto e o olho vira uma barra escura fina, em vez de afundar no crânio e
 * sumir. É assim que um rosto estilizado de poucos polígonos fecha o olho.
 *
 * ## Em que espaço isto mexe
 *
 * As posições cruas destes arquivos estão quase todas colapsadas na origem: a
 * geometria mora num espaço que só as matrizes inversas de bind desfazem. Nada
 * aqui mede nem desloca em espaço de geometria — tudo passa pela inversa de
 * bind do osso `Head`, que leva ao espaço LOCAL DA CABEÇA, onde "para cima" e
 * "para o lado" querem dizer alguma coisa. Depois volta.
 *
 * ## Por que a busca é por ILHA e não por primitivo
 *
 * O caminho óbvio — "o primitivo chamado `Eye`" — falha em quase metade do
 * elenco. Nas dez cabeças femininas o olho se chama `Brown`; em duas delas o
 * MESMO primitivo carrega olho e sobrancelha, e colapsar o primitivo inteiro
 * fecharia a sobrancelha junto com o olho. No fazendeiro e no operário o
 * primitivo `Eyebrows` carrega a BARBA. Já a ilha se descreve sozinha: um par
 * de blocos pequenos, espelhados em torno do zero, na metade de cima da cabeça
 * e virados para a frente. O par mais baixo é o olho, o de cima é a sobrancelha.
 *
 * E é essa busca que faz o astronauta e o tático — capacete e viseira, sem
 * rosto nenhum — simplesmente não terem reflexo, em vez de ganharem uma viseira
 * que pisca.
 */

/** Quanto o par desliza numa sacada, em fração da aresta de UM olho. */
const GAZE_SIDE = 0.24;
const GAZE_UP = 0.12;
/** Quanto a sobrancelha sobe na deriva, em fração da altura dela. */
const BROW_DRIFT = 0.10;

/** O que sobra da altura do olho quando ele fecha. Zero é geometria degenerada — invisível. */
const CLOSED = 0.08;

/** Uma ilha grande demais não é olho: é cabelo, pele, capacete ou viseira. */
const ISLAND_MAX = 64;
const CANDIDATE_MAX = 600;

interface Island {
  mesh: THREE.SkinnedMesh;
  /** Índices de vértice desta ilha dentro da geometria da malha. */
  verts: number[];
  centre: THREE.Vector3;
  size: THREE.Vector3;
}

interface Pair {
  islands: [Island, Island];
  centre: THREE.Vector3;
  /** Aresta de um olho: o cubo é quase cúbico, então uma medida serve para os três eixos. */
  edge: number;
}

export class FaceV2 {
  private readonly reflex = new Reflex();
  private eyes: Pair | null = null;
  private brows: Pair | null = null;
  private readonly toHead = new THREE.Matrix4();
  private readonly fromHead = new THREE.Matrix4();
  /** Descobertos da geometria, nunca escritos: presumir convenção de rig já custou caro neste projeto. */
  private up: 0 | 1 | 2 = 1;
  private side: 0 | 1 | 2 = 0;
  private clock = 0;
  private readonly drift = Math.random() * 100;
  /** Repouso no espaço da cabeça, por malha: três floats por vértice. */
  private readonly rest = new Map<THREE.SkinnedMesh, Float32Array>();
  private readonly owned: THREE.BufferGeometry[] = [];

  /**
   * @param meshes as malhas da CABEÇA, e só elas: uma calça não tem olho.
   * @param skeleton o esqueleto do avatar, para a inversa de bind do `Head`.
   */
  constructor(meshes: readonly THREE.SkinnedMesh[], skeleton: THREE.Skeleton) {
    const head = skeleton.bones.findIndex((b) => b.name === 'Head');
    if (head < 0) return;
    this.toHead.copy(skeleton.boneInverses[head]);
    this.fromHead.copy(this.toHead).invert();

    const islands: Island[] = [];
    for (const mesh of meshes) {
      const pos = mesh.geometry.getAttribute('position');
      if (!pos || pos.count === 0 || pos.count > CANDIDATE_MAX) continue;
      const local = this.toHeadSpace(mesh, pos);
      if (mesh.geometry.getIndex()) this.indexed++;
      for (const verts of connected(mesh.geometry, pos.count, local)) {
        this.found++;
        if (verts.length < 8 || verts.length > ISLAND_MAX) continue;
        islands.push(measure(mesh, verts, local));
      }
    }
    if (islands.length < 2) return;

    // O eixo LATERAL é aquele em que as duas ilhas de um par se separam. Não há
    // ambiguidade: um olho está de um lado do zero e o outro do outro.
    const pairs: Array<{ pair: Pair; axis: 0 | 1 | 2 }> = [];
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const found = mirrored(islands[i], islands[j]);
        if (found) pairs.push(found);
      }
    }
    if (!pairs.length) return;

    // O eixo do par mais votado manda: um rosto tem um lado só.
    const votes = [0, 0, 0];
    for (const p of pairs) votes[p.axis]++;
    this.side = votes.indexOf(Math.max(...votes)) as 0 | 1 | 2;
    const mine = pairs.filter((p) => p.axis === this.side).map((p) => p.pair);

    // O VERTICAL é o eixo em que os pares se empilham; se houver um par só, é o
    // eixo em que ele é mais achatado — um olho é largo e baixo.
    const rest = ([0, 1, 2] as const).filter((a) => a !== this.side);
    if (mine.length > 1) {
      const spread = (a: 0 | 1 | 2) => Math.max(...mine.map((p) => p.centre.getComponent(a)))
        - Math.min(...mine.map((p) => p.centre.getComponent(a)));
      this.up = spread(rest[0]) >= spread(rest[1]) ? rest[0] : rest[1];
    } else {
      this.up = mine[0].islands[0].size.getComponent(rest[0])
        <= mine[0].islands[0].size.getComponent(rest[1]) ? rest[0] : rest[1];
    }

    // O par de baixo é o OLHO; o logo acima dele, a sobrancelha. Numa cabeça em
    // que a sobrancelha está fundida no cabelo — são seis — não há segundo par,
    // e o rosto pisca sem mexer a sobrancelha. É o certo: não há o que mexer.
    mine.sort((a, b) => a.centre.getComponent(this.up) - b.centre.getComponent(this.up));
    this.eyes = mine[0];
    this.brows = mine[1] ?? null;
    for (const pair of [this.eyes, this.brows]) {
      if (!pair) continue;
      for (const island of pair.islands) this.own(island.mesh);
    }
  }

  /** As posições de uma malha no espaço do osso da cabeça, guardadas como repouso. */
  private toHeadSpace(mesh: THREE.SkinnedMesh, pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
    const hit = this.rest.get(mesh);
    if (hit) return hit;
    const rest = new Float32Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(this.toHead).toArray(rest, i * 3);
    }
    this.rest.set(mesh, rest);
    return rest;
  }

  /**
   * Toma a geometria da malha para si.
   *
   * `SkeletonUtils.clone` COMPARTILHA a geometria com o protótipo em cache:
   * mexer nela sem clonar faria a praça inteira piscar no mesmo quadro, e o
   * primeiro avatar a ser descartado apagaria o olho de todo mundo. Uma vez por
   * malha — nas duas cabeças em que olho e sobrancelha dividem o primitivo, os
   * dois pares apontam para a mesma.
   */
  private own(mesh: THREE.SkinnedMesh): void {
    if (this.owned.includes(mesh.geometry)) return;
    mesh.geometry = mesh.geometry.clone();
    this.owned.push(mesh.geometry);
  }

  /**
   * O que este rosto achou na cabeça.
   *
   * Existe pela mesma razão que o inventário de malhas da bancada: quando o
   * olho não pisca, a primeira pergunta é "ele foi ENCONTRADO?", e uma captura
   * não responde isso — um olho que não fecha e um olho que ninguém achou são a
   * mesma imagem.
   */
  describe(): Record<string, unknown> {
    return {
      olhos: this.eyes ? this.eyes.islands.map((i) => i.verts.length) : null,
      sobrancelhas: this.brows ? this.brows.islands.map((i) => i.verts.length) : null,
      eixoVertical: this.up,
      eixoLateral: this.side,
      aresta: this.eyes ? +this.eyes.edge.toFixed(5) : null,
      // Nulo quando não há olho: um rosto que não pisca porque ninguém achou o
      // olho e um rosto que não pisca porque não TEM olho são coisas
      // diferentes, e um zero não as separa.
      piscar: this.eyes ? +this.reflex.blink.toFixed(3) : null,
      ilhas: this.found,
      indexadas: this.indexed,
    };
  }

  /** Quantas ilhas candidatas a busca viu, e quantas malhas tinham índice. */
  private found = 0;
  private indexed = 0;

  /** Prende o piscar. O retrato do card usa isto: um card de olho fechado é um defeito que não se reproduz olhando o jogo. */
  pinBlink(value: number | null): void {
    this.reflex.pin(value);
  }

  update(dt: number): void {
    if (!this.eyes) return;
    this.reflex.update(dt);
    this.clock += dt;

    const eyes = this.eyes;
    const shut = 1 - this.reflex.blink * (1 - CLOSED);
    const mid = eyes.centre.getComponent(this.up);
    const slideSide = this.reflex.gaze.x * eyes.edge * GAZE_SIDE;
    const slideUp = this.reflex.gaze.y * eyes.edge * GAZE_UP;
    this.deform(eyes, (out) => {
      // Achata em torno da linha do olho e NÃO mexe em profundidade: é o que
      // mantém a face frontal do cubo à frente da pele, virando uma barra
      // escura em vez de afundar no crânio.
      out[this.up] = mid + (out[this.up] - mid) * shut + slideUp;
      out[this.side] += slideSide;
    });

    if (this.brows) {
      // A sobrancelha DERIVA, devagar e de leve. Um rosto vivo nunca está
      // exatamente parado. A amplitude é minúscula de propósito: isto não pode
      // ler como expressão, senão o avatar fica fazendo caretas sozinho. Fase
      // aleatória por avatar, senão a praça inteira levanta a sobrancelha no
      // mesmo quadro.
      const t = this.clock + this.drift;
      const wave = Math.sin(t * 0.41) * 0.5 + Math.sin(t * 0.23 + 1.7) * 0.5;
      const lift = wave * this.brows.islands[0].size.getComponent(this.up) * BROW_DRIFT
        + slideUp * 0.5;
      this.deform(this.brows, (out) => { out[this.up] += lift; });
    }
  }

  private readonly scratch = new THREE.Vector3();
  private readonly out: [number, number, number] = [0, 0, 0];

  private deform(pair: Pair, fn: (out: [number, number, number]) => void): void {
    for (const island of pair.islands) {
      const pos = island.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const rest = this.rest.get(island.mesh);
      if (!rest) continue;
      for (const i of island.verts) {
        this.out[0] = rest[i * 3];
        this.out[1] = rest[i * 3 + 1];
        this.out[2] = rest[i * 3 + 2];
        fn(this.out);
        this.scratch.set(this.out[0], this.out[1], this.out[2]).applyMatrix4(this.fromHead);
        pos.setXYZ(i, this.scratch.x, this.scratch.y, this.scratch.z);
      }
      pos.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    this.rest.clear();
    this.eyes = null;
    this.brows = null;
  }
}

/**
 * As ilhas de uma geometria: grupos de vértices ligados por triângulo **ou por
 * posição**.
 *
 * É o que separa o olho da sobrancelha quando os dois dividem o primitivo, e a
 * barba do fazendeiro do que interessa. Uma malha sem índice é tratada como
 * triângulos soltos de três em três, que é o que ela é.
 *
 * **A solda por posição não é um detalhe.** Estas malhas são de sombreamento
 * chapado: cada face do cubo do olho tem os quatro vértices SÓ dela, com a
 * normal dela, e o índice nunca liga uma face à vizinha. Percorrer só os
 * triângulos quebra um cubo de 24 vértices em seis ilhas de 4 — pequenas demais
 * para serem olho, e a busca inteira devolvia nada. Vértices que ocupam o mesmo
 * ponto são o mesmo canto, e é por aí que as faces se ligam.
 */
function* connected(geometry: THREE.BufferGeometry, count: number, local: Float32Array): Generator<number[]> {
  const index = geometry.getIndex();
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  // Solda por posição. A tolerância vem do tamanho da própria malha, porque
  // estas coordenadas são minúsculas — um epsilon absoluto certo aqui seria
  // grosseiro numa cabeça e cego noutra.
  let extent = 0;
  for (let i = 0; i < count * 3; i++) extent = Math.max(extent, Math.abs(local[i]));
  const grid = extent > 0 ? 1 / (extent * 1e-4) : 1e6;
  const at = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(local[i * 3] * grid)},${Math.round(local[i * 3 + 1] * grid)},${Math.round(local[i * 3 + 2] * grid)}`;
    const first = at.get(key);
    if (first === undefined) at.set(key, i); else union(first, i);
  }

  const total = index ? index.count : count;
  for (let t = 0; t + 2 < total; t += 3) {
    const a = index ? index.getX(t) : t;
    const b = index ? index.getX(t + 1) : t + 1;
    const c = index ? index.getX(t + 2) : t + 2;
    union(a, b); union(b, c);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i); else groups.set(root, [i]);
  }
  for (const list of groups.values()) yield list;
}

function measure(mesh: THREE.SkinnedMesh, verts: number[], local: Float32Array): Island {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const v = new THREE.Vector3();
  for (const i of verts) {
    v.set(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]);
    min.min(v); max.max(v);
  }
  return {
    mesh, verts,
    centre: min.clone().add(max).multiplyScalar(0.5),
    size: max.sub(min),
  };
}

/**
 * Duas ilhas são um PAR se forem espelhadas em torno do zero num eixo e
 * estiverem à mesma altura nos outros dois — que é o que dois olhos são, e o
 * que uma orelha e um brinco não são.
 */
function mirrored(a: Island, b: Island): { pair: Pair; axis: 0 | 1 | 2 } | null {
  if (a.verts.length !== b.verts.length) return null;
  for (const axis of [0, 1, 2] as const) {
    const ca = a.centre.getComponent(axis);
    const cb = b.centre.getComponent(axis);
    const span = Math.max(Math.abs(ca), Math.abs(cb));
    // De lados opostos, à mesma distância do zero, e longe o bastante um do
    // outro para não ser a mesma coisa medida duas vezes.
    if (ca * cb >= 0 || span < 1e-6) continue;
    if (Math.abs(Math.abs(ca) - Math.abs(cb)) > span * 0.2) continue;
      const others = ([0, 1, 2] as const).filter((x) => x !== axis);
    // Tolerância medida na PRÓPRIA ILHA, não na distância ao zero. Com uma
    // folga proporcional ao span, o olho esquerdo emparelha com a sobrancelha
    // direita — elas estão a menos de um olho de distância em altura — e o
    // rosto acaba levantando um olho junto com uma sobrancelha.
    const aligned = others.every((x) => {
      const tol = Math.min(a.size.getComponent(x), b.size.getComponent(x)) * 0.35;
      return Math.abs(a.centre.getComponent(x) - b.centre.getComponent(x)) <= tol;
    });
    if (!aligned) continue;
    const centre = a.centre.clone().add(b.centre).multiplyScalar(0.5);
    // A aresta de UM olho, não do par: o cubo é quase cúbico, então a menor
    // dimensão da ilha serve de régua para os três eixos.
    const edge = Math.min(a.size.x, a.size.y, a.size.z);
    return { pair: { islands: [a, b], centre, edge }, axis };
  }
  return null;
}
