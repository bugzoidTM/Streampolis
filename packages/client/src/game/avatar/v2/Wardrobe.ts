import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetManager } from '../../assets/loading.js';

/**
 * O guarda-roupa do avatar v2: peças de roupa que vestem um esqueleto comum.
 *
 * O avatar v1 gerava o corpo e LOFTAVA cada peça a partir das estações dele —
 * 45 roupas feitas à mão e um portão de 176 combinações para medir onde a pele
 * escapava. O v2 troca isso por uma coincidência que os pacotes Ultimate
 * Modular da Quaternius oferecem de graça: 21 personagens divididos em quatro
 * malhas (`Body`, `Legs`, `Feet`, `Head`) e **todos com o mesmo esqueleto de 62
 * ossos, na mesma ordem**. Vestir passa a ser carregar a peça e amarrá-la ao
 * esqueleto que já está em cena.
 *
 * `tools/assets/characters.mjs` corta os personagens nessas peças e escreve
 * `assets/wardrobe/catalog.json`.
 */

const BASE = 'assets/wardrobe/';

export type PartSlot = 'head' | 'top' | 'bottom' | 'shoes';

export interface PartDef {
  id: string;
  slot: PartSlot;
  character: string;
  gender: 'f' | 'm';
}

interface Loaded {
  scene: THREE.Group;
}

/**
 * Qual dos DOIS esqueletos a peça usa.
 *
 * Os 21 personagens dividem os nomes e a ordem dos 62 ossos — é o que faz uma
 * calça vestir outro corpo —, mas os dois pacotes têm POSES DE BIND diferentes.
 * O prefixo do id é o rig: `f_suit_top` é do rig feminino, `m_casual_...` do
 * masculino.
 */
export type Rig = 'f' | 'm';

export const rigOf = (id: string): Rig => (id.startsWith('f_') ? 'f' : 'm');

/** O personagem de onde a peça veio: o id sem o sufixo do slot. */
export const characterOf = (id: string): string => id.replace(/_(head|top|bottom|shoes)$/, '');

/**
 * O FORRO: a peça que faz as vezes de corpo por baixo da roupa.
 *
 * Não está no catálogo — ninguém compra o próprio corpo. Existe porque este
 * pacote não tem corpo: as quatro peças SÃO o personagem, e cada personagem foi
 * desenhado como um conjunto fechado. A saia da bruxa para no joelho porque a
 * bota dela sobe até lá; com um tênis baixo sobram dezoito centímetros de canela
 * inexistente e enxerga-se o cenário através do avatar. Na cintura é o mesmo,
 * e ali é só entre RIGS: blusa feminina desce até 1,06 e calça masculina sobe
 * até 0,97.
 *
 * É UMA peça e não duas, e a mesma para os dois rigs, porque medindo a faixa
 * que cada peça ocupa na coluna do corpo só uma alcança as duas pontas
 * sozinha — do tornozelo (0,12 m) até acima do umbigo (1,08 m). Ver
 * `tools/assets/characters.mjs`.
 */
export const LINING = 'under_body';

/**
 * Encolhe uma malha para dentro, ao longo das próprias normais.
 *
 * O forro é uma PEÇA DE ROUPA fazendo as vezes de corpo, e duas roupas de
 * formatos diferentes sobre as mesmas pernas se atravessam em manchas — não é
 * briga de profundidade, que `polygonOffset` resolveria, é interpenetração de
 * verdade. Afundar o forro dois centímetros o põe por dentro de tudo, e a única
 * hora em que ele aparece continua sendo o vão que ele veio tapar.
 *
 * O deslocamento é dado em METROS e convertido para o espaço da geometria pela
 * escala que a malha tem no mundo — nestes arquivos ela é cem vezes menor que o
 * mundo, e um valor absoluto escrito à mão seria imperceptível numa cabeça e
 * catastrófico noutra.
 */
/** Resolução da varredura de cobertura, em metros. */
export const BANDA = 0.004;

/** Um vão menor do que isto é costura entre duas peças, não buraco. */
export const VAO_MINIMO = 0.006;

/**
 * Onde a COLUNA do corpo não tem superfície nenhuma — os buracos do traje.
 *
 * É a falha que só o v2 pode ter. No corpo procedural existe um corpo por
 * baixo e a roupa é ele inflado, então o pior caso é pele à mostra; aqui não
 * existe corpo nenhum — as quatro peças SÃO o personagem, o `top` traz o pano
 * e os braços, o `bottom` traz as pernas — e duas peças que não se encontram
 * deixam ver o CENÁRIO através do avatar.
 *
 * Mede por faixa de altura e não por raio: com os vértices já deformados pelo
 * esqueleto, marcar as faixas que cada triângulo cruza custa uma passada pela
 * malha, enquanto raio contra malha com pele custa uma travessia por disparo.
 *
 * Só a COLUNA central conta (`EIXO`). Sem esse recorte um braço pendurado ao
 * lado do quadril cobre a faixa da cintura e o buraco passa despercebido — foi
 * exatamente assim que a sonda de pele do corpo v1 escondeu por meses a cunha
 * do quadril.
 *
 * A janela vai do peito do pé ao queixo: abaixo dela é solado e acima é cabelo,
 * e nem um nem outro têm o que provar.
 */
export function columnGaps(
  vestido: Posed[], stature: number,
): Array<[number, number]> {
  const EIXO = 0.12;
  const bandas = new Uint8Array(Math.ceil(2.4 / BANDA));
  for (const { mesh, mundo } of vestido) {
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : mundo.length / 3;
    for (let t = 0; t + 2 < count; t += 3) {
      const ia = (index ? index.getX(t) : t) * 3;
      const ib = (index ? index.getX(t + 1) : t + 1) * 3;
      const ic = (index ? index.getX(t + 2) : t + 2) * 3;
      if (Math.abs((mundo[ia] + mundo[ib] + mundo[ic]) / 3) > EIXO) continue;
      const ya = mundo[ia + 1]; const yb = mundo[ib + 1]; const yc = mundo[ic + 1];
      const lo = Math.max(0, Math.floor(Math.min(ya, yb, yc) / BANDA));
      const hi = Math.min(bandas.length - 1, Math.floor(Math.max(ya, yb, yc) / BANDA));
      for (let y = lo; y <= hi; y++) bandas[y] = 1;
    }
  }
  const de = Math.floor((stature * 0.07) / BANDA);
  const ate = Math.floor((stature * 0.84) / BANDA);
  const vaos: Array<[number, number]> = [];
  let corrida = -1;
  for (let i = de; i <= ate; i++) {
    if (!bandas[i]) { if (corrida < 0) corrida = i; } else if (corrida >= 0) { vaos.push([corrida, i]); corrida = -1; }
  }
  if (corrida >= 0) vaos.push([corrida, ate + 1]);
  return vaos
    .map(([lo, hi]) => [lo * BANDA, hi * BANDA] as [number, number])
    .filter(([lo, hi]) => hi - lo >= VAO_MINIMO);
}

/**
 * Folga por OSSO e faixa de altura: o raio mínimo do TRAJE em volta daquele
 * osso, naquela altura.
 */
export type Clearance = Map<number, Float32Array>;

/**
 * Uma malha do traje com os vértices JÁ DEFORMADOS pelo esqueleto, no mundo.
 *
 * `getVertexPosition` de uma malha com pele custa quatro multiplicações de
 * matriz por vértice, e as duas medidas do forro — onde há buraco e quanto o
 * traje deixa livre — precisam dos mesmos pontos. Deformar uma vez e passar o
 * resultado adiante era metade do tempo de montar um avatar misto; ler os três
 * cantos de cada triângulo direto da malha, como a versão anterior fazia,
 * pagava o mesmo vértice seis vezes.
 */
export interface Posed {
  mesh: THREE.SkinnedMesh;
  /** x, y, z de cada vértice, no mundo. */
  mundo: Float32Array;
}

/** Deforma a malha uma vez e guarda os vértices no mundo. */
export function posed(mesh: THREE.SkinnedMesh): Posed {
  const total = mesh.geometry.getAttribute('position').count;
  const mundo = new Float32Array(total * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < total; i++) {
    mesh.getVertexPosition(i, p);
    mesh.localToWorld(p);
    mundo[i * 3] = p.x; mundo[i * 3 + 1] = p.y; mundo[i * 3 + 2] = p.z;
  }
  return { mesh, mundo };
}

/** Até que distância em altura um osso ainda pode ser o eixo de um vértice. */
const ALCANCE_OSSO = 0.6;

/**
 * Em quantas direções a folga é medida em volta do eixo.
 *
 * Oito: fino o bastante para separar a frente do lado de um quadril (que é o
 * caso que pedia setores) e grosso o bastante para cada casa receber vértices
 * de peças com poucos polígonos. Com trinta e dois, metade das casas de uma
 * bainha de doze faces ficaria vazia, e casa vazia é folga infinita — o forro
 * sairia solto justamente na emenda.
 */
const SETORES = 8;

/** Em qual setor cai a direção (dx, dz) medida a partir do eixo. */
const setorDe = (dx: number, dz: number): number => {
  const a = Math.atan2(dz, dx) / (Math.PI * 2);
  return Math.min(SETORES - 1, Math.floor((a - Math.floor(a)) * SETORES));
};

/**
 * Quão apertado o traje é em volta de cada membro, faixa de altura por faixa.
 *
 * É a medida que diz **onde o forro cabe**. Sem ela o aperto é um número
 * escolhido a dedo, e um número não sabe o que está apertando: o mesmo valor
 * que enfia o forro por dentro de uma legging justa transforma a canela numa
 * lâmina quando quem está por perto é o cano largo de uma bota. Foi o que
 * aconteceu — a 70% de aperto na emenda, o que se via entrando na bota era uma
 * navalha cor de pele.
 *
 * A medida é guardada **por osso**, e cada vértice do traje entra na conta de
 * TODOS os ossos que passam perto da altura dele, não só do seu próprio. Isso
 * não é desperdício, é a única forma de a comparação significar alguma coisa:
 * quem vai consultar esta tabela é um vértice de forro, em volta do osso DELE,
 * e a bota é pesada no osso do PÉ enquanto a canela do forro é pesada no da
 * perna. Medida cada uma em volta do seu, "o forro tem 8 cm e a bota deixa
 * 8,8" compara duas distâncias tiradas de eixos a três centímetros um do
 * outro, e a conclusão de que cabe é falsa — era assim que a perna aparecia
 * por cima do cano da bota com a tabela dizendo que estava tudo bem.
 *
 * E **por DIREÇÃO**, não só por altura. Um raio mínimo por faixa descreve um
 * cano; o corpo humano não é um cano. Um cinto em volta do quadril tem nove
 * centímetros de frente para trás e dezoito de lado a lado, e o menor raio da
 * faixa — os nove — passa a valer para todas as direções: o forro é apertado
 * até caber na medida da FRENTE e, de lado, encolhe para dentro do que não
 * precisava. Ao mesmo tempo, o inverso também acontecia, e era o defeito que
 * sobrava: quando a peça só existe num setor, o mínimo vinha de onde ela está e
 * era aplicado onde ela não está. Por setor, cada direção responde por si.
 *
 * De cada casa fica o MENOR raio: o forro tem de caber no ponto mais justo,
 * não no médio. Peça longe do eixo — a saia rodada em volta da canela — dá raio
 * grande e não restringe nada, que é o certo: a perna cabe folgada dentro de
 * uma saia.
 */
export function outfitClearance(vestido: Posed[], quais: Iterable<number>): Clearance {
  const bandas = Math.ceil(2.4 / BANDA);
  const porOsso: Clearance = new Map();
  // Só os ossos que o FORRO usa, que são os únicos que alguém vai consultar.
  // Medir os 62 é medir o esqueleto inteiro para responder sobre uma dúzia de
  // ossos de perna e quadril, e custava seis vezes mais.
  const alvos = [...new Set(quais)];
  for (const { mesh, mundo } of vestido) {
    const ossos = mesh.skeleton?.bones;
    if (!ossos) continue;
    for (let i = 0; i < mundo.length; i += 3) {
      const x = mundo[i]; const y = mundo[i + 1]; const z = mundo[i + 2];
      const faixa = Math.floor(y / BANDA);
      if (faixa < 0 || faixa >= bandas) continue;
      for (const b of alvos) {
        const e = ossos[b].matrixWorld.elements;
        if (Math.abs(e[13] - y) > ALCANCE_OSSO) continue;
        const dx = x - e[12]; const dz = z - e[14];
        const raio = Math.hypot(dx, dz);
        let perfil = porOsso.get(b);
        if (!perfil) {
          perfil = new Float32Array(bandas * SETORES).fill(Infinity);
          porOsso.set(b, perfil);
        }
        const casa = faixa * SETORES + setorDe(dx, dz);
        if (raio < perfil[casa]) perfil[casa] = raio;
      }
    }
  }
  return porOsso;
}

/**
 * Deixa da malha só o que está dentro de uma das faixas de altura, **cortando
 * a geometria na borda** e não escolhendo triângulos inteiros.
 *
 * É o que torna o forro utilizável. Um forro de corpo inteiro é uma PEÇA DE
 * ROUPA fazendo as vezes de corpo, e duas roupas de formatos diferentes sobre
 * as mesmas pernas se atravessam: medindo em pixel, o forro inteiro aparecia
 * por cima do traje em 12% da silhueta, em 28 de 30 visuais misturados —
 * manchas cor de pele no meio da calça, defeito pior do que o vão que ele veio
 * tapar, e que aparecia em TODO visual misturado e não só nos que tinham vão.
 *
 * Recortado ao vão, o forro só existe onde não há mais nada, que é o único
 * lugar em que ele tem o direito de aparecer. A margem o enfia alguns
 * centímetros por baixo das peças vizinhas, para o encontro não virar uma
 * emenda visível.
 *
 * **Cortar é diferente de escolher.** A primeira versão guardava o triângulo
 * inteiro quando ele encostava na faixa, o que parecia conservador e não era:
 * os triângulos deste doador têm quinze centímetros de altura, e um vão de dois
 * — o que sobra entre a bota e a calça do traje espacial — arrastava para
 * dentro da roupa um pedaço de perna sete vezes maior do que o buraco. Ali
 * dentro ele não tem como se comportar: está longe de qualquer bainha, o aperto
 * medido não o alcança, e o que se via era pele saindo pelo meio da coxa em
 * lascas. Cortado no plano, o forro existe na faixa e em mais nada.
 *
 * O corte é o de Sutherland–Hodgman contra dois planos horizontais, feito na
 * altura JÁ DEFORMADA pelo esqueleto (é lá que o vão foi medido) e escrito de
 * volta interpolando os atributos. Peso de osso não se interpola: o vértice
 * novo herda os do vizinho mais próximo, que é o que ele seria se o autor da
 * malha o tivesse desenhado.
 *
 * A geometria é CLONADA porque ela é do kit, e o kit é compartilhado por todos
 * os avatares em cena: recortar no lugar tiraria a perna de todo mundo.
 */
export function clipToBands(
  mesh: THREE.SkinnedMesh, bands: Array<[number, number]>, margin: number,
): void {
  const geometry = mesh.geometry;
  const index = geometry.getIndex();
  if (!index) return;

  const nomes = Object.keys(geometry.attributes);
  const origem = nomes.map((nome) => geometry.getAttribute(nome));
  const pesos = new Set(['skinIndex', 'skinWeight']);

  const total = origem[0].count;
  // Tudo relido por `getComponent`, nunca copiado do buffer cru: o atributo
  // pode ser INTERCALADO (um só buffer com posição, normal e uv lado a lado),
  // e nesse caso o buffer cru não é a lista de valores deste atributo. Copiá-lo
  // embaralhava índice de osso com coordenada de textura, e o esqueleto vinha
  // buscar um osso que não existe.
  const saida = origem.map((attr) => {
    const dados: number[] = [];
    for (let i = 0; i < attr.count; i++) {
      for (let c = 0; c < attr.itemSize; c++) dados.push(attr.getComponent(i, c));
    }
    return dados;
  });
  const alturaY = new Float32Array(total);
  const p = new THREE.Vector3();
  for (let i = 0; i < total; i++) {
    mesh.getVertexPosition(i, p);
    mesh.localToWorld(p);
    alturaY[i] = p.y;
  }

  const alturas: number[] = Array.from(alturaY);
  const cache = new Map<string, number>();
  /** Um vértice novo no meio da aresta a–b, e a altura em que ele caiu. */
  const cortar = (a: number, b: number, t: number, y: number): number => {
    const chave = `${a}:${b}:${t.toFixed(4)}`;
    const feito = cache.get(chave);
    if (feito !== undefined) return feito;
    const id = alturas.length;
    for (let k = 0; k < nomes.length; k++) {
      const attr = origem[k];
      const dados = saida[k];
      const itens = attr.itemSize;
      // Índice e peso de osso vêm inteiros do vizinho mais próximo: interpolar
      // um ÍNDICE de osso produz um osso que não existe, e misturar os pesos de
      // dois conjuntos diferentes de ossos deforma o vértice para o meio do
      // corpo.
      const perto = pesos.has(nomes[k]) ? (t < 0.5 ? a : b) : -1;
      for (let c = 0; c < itens; c++) {
        dados.push(perto >= 0
          ? attr.getComponent(perto, c)
          : attr.getComponent(a, c) + (attr.getComponent(b, c) - attr.getComponent(a, c)) * t);
      }
    }
    alturas.push(y);
    cache.set(chave, id);
    return id;
  };

  const meia = (poly: number[], plano: number, acima: boolean): number[] => {
    const fora: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]; const b = poly[(i + 1) % poly.length];
      const ya = alturas[a]; const yb = alturas[b];
      const dentroA = acima ? ya >= plano : ya <= plano;
      const dentroB = acima ? yb >= plano : yb <= plano;
      if (dentroA) fora.push(a);
      if (dentroA !== dentroB) fora.push(cortar(a, b, (plano - ya) / (yb - ya), plano));
    }
    return fora;
  };

  const triangulos: number[] = [];
  for (const [de, ate] of bands) {
    const baixo = de - margin; const alto = ate + margin;
    for (let t = 0; t + 2 < index.count; t += 3) {
      const tri = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      const lo = Math.min(alturas[tri[0]], alturas[tri[1]], alturas[tri[2]]);
      const hi = Math.max(alturas[tri[0]], alturas[tri[1]], alturas[tri[2]]);
      if (hi < baixo || lo > alto) continue;
      let poly = tri;
      if (lo < baixo) poly = meia(poly, baixo, true);
      if (poly.length >= 3 && hi > alto) poly = meia(poly, alto, false);
      for (let k = 1; k + 1 < poly.length; k++) triangulos.push(poly[0], poly[k], poly[k + 1]);
    }
  }

  const recortada = new THREE.BufferGeometry();
  for (let k = 0; k < nomes.length; k++) {
    const attr = origem[k];
    const dados = saida[k];
    // O tipo do array importa: `skinIndex` é inteiro, e um Float32 no lugar
    // dele faz o shader ler o osso errado.
    // Índice de osso é INTEIRO e sai num array inteiro; o resto sai em ponto
    // flutuante e sem normalização, porque `getComponent` já devolveu o valor
    // desnormalizado e escrevê-lo de volta num byte o zeraria.
    const bruto = nomes[k] === 'skinIndex'
      ? new Uint16Array(dados) : new Float32Array(dados);
    recortada.setAttribute(nomes[k], new THREE.BufferAttribute(bruto, attr.itemSize, false));
  }
  recortada.setIndex(triangulos);
  mesh.geometry = recortada;
}

/**
 * Aperta o forro **em torno do eixo do membro**, uma escala radial.
 *
 * Duas versões anteriores empurravam cada vértice ao longo da própria NORMAL,
 * e as duas quebraram de um jeito que só o close mostrou:
 *
 * 1. Malha de sombreamento chapado tem os quatro vértices de cada face só
 *    dela, e três ou quatro deles na mesma posição com normais diferentes.
 *    Empurrar cada um pela sua normal SEPARA os irmãos: a malha rasga em toda
 *    aresta viva e a canela fica coberta de fiapos claros por onde se vê o que
 *    está atrás. (Nestas malhas, quem é vizinho é vizinho por POSIÇÃO, nunca
 *    por índice — a mesma lição da busca do olho em `FaceV2`.)
 * 2. Soldar as normais consertou o rasgo e trouxe o CONE. A borda de uma tampa
 *    tem normal inclinada e anda para dentro; o centro dela aponta para cima e
 *    não anda; o disco vira um bico. Era o espeto que saía da cintura.
 *
 * A direção certa não é a normal, é o RAIO: todo vértice anda em direção ao
 * eixo do próprio membro, tampa e parede juntas, na mesma proporção. Um disco
 * encolhe como disco, um tubo como tubo, e vértices coincidentes andam juntos
 * porque partilham a posição — o rasgo não pode voltar por construção.
 *
 * **E o eixo do membro é o OSSO que manda no vértice**, não uma coluna
 * escrita à mão. A versão anterior punha o eixo das pernas em x = ±9 cm, um
 * número medido uma vez numa pose e verdadeiro em nenhuma: a perna do avatar
 * parado está mais para fora do que isso. Encolher em direção a um eixo que
 * está fora do lugar não aperta o forro, DESLOCA — ele saía pela face interna
 * da perna, e a máscara de profundidade mostrava exatamente isso: azul (forro
 * por baixo) na metade de fora da bainha e vermelho (forro furando o pano) na
 * metade de dentro, na mesma bainha. O osso dominante do vértice está no
 * centro do membro por definição, em qualquer pose, e serve igual para a
 * cintura, onde quem manda é a espinha.
 *
 * O aperto de fundo é pedido em FRAÇÃO DO RAIO LOCAL, nunca em metros. Metros
 * não sabem o que estão encolhendo: 4,5 cm são folga numa cintura de 20 cm de
 * raio e são a morte de uma canela de 5 cm, onde o vértice atravessa o eixo e
 * sai pelo outro lado — a peça explode em lascas atravessando a perna.
 *
 * **E na emenda quem manda não é fração nenhuma, é a peça vizinha.** Duas
 * gerações deste código apertaram a emenda por um número escolhido a dedo, e as
 * duas ficaram presas entre dois defeitos: frouxo, o forro fura o pano e sobra
 * uma golinha cor de pele em volta da bainha; apertado — 70% cheguei a medir —,
 * a canela vira uma navalha visível entrando na bota, porque a mesma fração que
 * é justa dentro de uma legging é absurda dentro de um cano largo. Não há
 * número que sirva para os dois: o que decide é o raio DA PEÇA que está por
 * cima, e `outfitClearance` o mede. Aqui o forro só encolhe até caber, com a
 * folga de uma parede de pano, e nunca mais do que isso.
 *
 * A conta é feita no MUNDO, que é onde "raio do membro" quer dizer alguma
 * coisa, e escrita de volta pela inversa da matriz de pele do próprio vértice.
 * Ler a escala da matriz do nó não serve: estas malhas guardam a posição num
 * espaço pré-esqueleto minúsculo e quem as leva ao mundo é a cadeia
 * `bindMatrix` → osso → `bindMatrixInverse`, não a matriz do nó.
 */
/**
 * Os ossos que mandam nos vértices desta malha.
 *
 * A folga do traje só precisa ser medida em volta destes: são os que o forro
 * vai consultar, e são uma dúzia contra os 62 do esqueleto.
 */
export function dominantBones(mesh: THREE.SkinnedMesh): Set<number> {
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const ossos = new Set<number>();
  if (!skinIndex || !skinWeight) return ossos;
  for (let i = 0; i < skinIndex.count; i++) {
    let dom = -1; let maior = 0;
    for (let j = 0; j < 4; j++) {
      const peso = skinWeight.getComponent(i, j);
      if (peso > maior) { maior = peso; dom = skinIndex.getComponent(i, j); }
    }
    if (dom >= 0) ossos.add(dom);
  }
  return ossos;
}

/**
 * Até onde o forro pode engordar nesta altura, em raio.
 *
 * Debaixo de uma peça, é o raio dela menos uma parede de pano. No vão, onde não
 * há peça, o forro É a perna e não tem teto — mas o vão acaba, e a bainha de
 * quem está por cima não pode ganhar uma golinha cor de pele em volta: a
 * restrição da borda entra e vai soltando ao longo da rampa, para o forro
 * chegar à emenda já do tamanho que passa por dentro dela.
 */
function ceiling(
  under: { clearance: Clearance; folga: number; ramp: number },
  bone: number, y: number, setor: number, natural: number,
): number {
  const perfil = under.clearance.get(bone);
  if (!perfil) return Infinity;
  const bandas = perfil.length / SETORES;
  const faixa = Math.floor(y / BANDA);
  if (faixa < 0 || faixa >= bandas) return Infinity;
  const aqui = perfil[faixa * SETORES + setor];
  if (Number.isFinite(aqui)) return aqui - under.folga;
  const passos = Math.ceil(under.ramp / BANDA);
  for (let d = 1; d <= passos; d++) {
    for (const j of [faixa - d, faixa + d]) {
      if (j < 0 || j >= bandas) continue;
      const medida = perfil[j * SETORES + setor];
      if (!Number.isFinite(medida)) continue;
      const t = (d * BANDA) / under.ramp;
      return (medida - under.folga) * (1 - t) + natural * t;
    }
  }
  return Infinity;
}

export function shrink(
  mesh: THREE.SkinnedMesh, fraction: number,
  under?: { clearance: Clearance; folga: number; ramp: number; piso: number },
): void {
  const geometry = mesh.geometry.clone();
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  if (!skinIndex || !skinWeight) return;

  const p = new THREE.Vector3();
  const delta = new THREE.Vector3();
  const pele = new THREE.Matrix4();
  const soma = new THREE.Matrix4();
  const osso = new THREE.Matrix4();
  const inversa = new THREE.Matrix4();
  const skeleton = mesh.skeleton;

  for (let i = 0; i < pos.count; i++) {
    mesh.getVertexPosition(i, p);
    mesh.localToWorld(p);

    // O eixo é o OSSO que mais pesa neste vértice, e a mesma varredura que
    // monta a matriz de pele já o encontra.
    soma.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    let dominante = -1;
    let maior = 0;
    for (let j = 0; j < 4; j++) {
      const peso = skinWeight.getComponent(i, j);
      if (peso === 0) continue;
      const b = skinIndex.getComponent(i, j);
      if (peso > maior) { maior = peso; dominante = b; }
      osso.multiplyMatrices(skeleton.bones[b].matrixWorld, skeleton.boneInverses[b]);
      for (let k = 0; k < 16; k++) soma.elements[k] += osso.elements[k] * peso;
    }
    if (dominante < 0) continue;
    const bone = skeleton.bones[dominante];
    const eixo = bone.matrixWorld.elements;
    delta.set(p.x - eixo[12], 0, p.z - eixo[14]);
    const raio = delta.length();
    if (raio < 1e-4) continue;

    // O raio de repouso: um aperto de fundo, para o forro ficar por dentro
    // mesmo onde não há peça nenhuma medindo por ele.
    let alvo = raio * (1 - fraction);
    if (under) {
      const teto = ceiling(under, dominante, p.y, setorDe(delta.x, delta.z), alvo);
      if (teto < alvo) alvo = Math.max(teto, under.piso);
    }
    delta.multiplyScalar(-Math.min(1 - alvo / raio, 0.9));

    // Do mundo de volta ao espaço da geometria, pela matriz de pele DESTE
    // vértice: `bindMatrixInverse · (Σ wⱼ · ossoⱼ · inversaⱼ) · bindMatrix`,
    // que é o que `getVertexPosition` aplica, mais a matriz do nó.
    pele.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
    pele.multiply(soma).multiply(mesh.bindMatrix);
    inversa.copy(pele).invert();
    // Como VETOR: a translação da matriz não entra num deslocamento.
    const e = inversa.elements;
    pos.setXYZ(i,
      pos.getX(i) + e[0] * delta.x + e[4] * delta.y + e[8] * delta.z,
      pos.getY(i) + e[1] * delta.x + e[5] * delta.y + e[9] * delta.z,
      pos.getZ(i) + e[2] * delta.x + e[6] * delta.y + e[10] * delta.z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  mesh.geometry = geometry;
}

const parts = new Map<string, Promise<Loaded>>();
const clipsByRig = new Map<Rig, Promise<THREE.AnimationClip[]>>();
let catalogPromise: Promise<PartDef[]> | null = null;

const url = (file: string) => new URL(`${BASE}${file}`, document.baseURI).href;

/** O carregador passa pelo manager compartilhado: a barra de carregamento conta. */
const loader = () => new GLTFLoader(assetManager);

/**
 * Uma peça, carregada uma vez.
 *
 * Cada arquivo traz o esqueleto inteiro além da malha — é o que a deformação
 * exige. O protótipo fica em cache e cada avatar leva um CLONE
 * (`SkeletonUtils.clone`, o único que refaz o vínculo do esqueleto).
 */
export function loadPart(id: string): Promise<Loaded> {
  const hit = parts.get(id);
  if (hit) return hit;
  const p = loader().loadAsync(url(`${id}.glb`)).then((gltf) => ({ scene: gltf.scene as THREE.Group }));
  // Falha NÃO fica no cache. Um 502, um Wi-Fi que oscila 200 ms ou as cinco
  // requisições que o pré-carregamento dispara juntas gravariam a promessa
  // rejeitada, e a partir daí ninguém mais conseguiria aquela peça na sessão
  // inteira — só um F5. Esquecer o erro é o que dá ao próximo avatar uma
  // segunda chance.
  p.catch(() => { if (parts.get(id) === p) parts.delete(id); });
  parts.set(id, p);
  return p;
}

/**
 * As 24 animações do pacote — **uma coleção por rig**.
 *
 * Dentro de um pacote elas são idênticas nos dez ou onze personagens; guardar
 * uma cópia por peça seria vinte e uma vezes o mesmo keyframe. O
 * `AnimationMixer` do three amarra as faixas pelo NOME do nó, então um arquivo
 * sem malha nenhuma anima qualquer combinação DAQUELE rig.
 *
 * **Entre os dois rigs elas não se emprestam.** As faixas são rotações
 * ABSOLUTAS de osso, e as duas poses de bind diferem em 1,34 no `Shoulder.L`:
 * tocar a faixa da mulher num esqueleto masculino não reproduz a pose autorada,
 * põe o braço na pose dela mais a diferença entre os repousos. Foi assim que
 * todo avatar masculino do jogo — inclusive o padrão de quem entra — passou a
 * andar pela praça com os dois braços esticados para a frente.
 */
export function loadClips(rig: Rig): Promise<THREE.AnimationClip[]> {
  const hit = clipsByRig.get(rig);
  if (hit) return hit;
  const p = loader().loadAsync(url(`animations_${rig}.glb`)).then((g) => g.animations);
  p.catch(() => { if (clipsByRig.get(rig) === p) clipsByRig.delete(rig); });
  clipsByRig.set(rig, p);
  return p;
}

export function loadCatalog(): Promise<PartDef[]> {
  catalogPromise ??= fetch(url('catalog.json'))
    .then((r) => r.json())
    .then((j) => j.parts as PartDef[])
    .catch(() => []);
  return catalogPromise;
}

/** Um exemplar novo da peça, com esqueleto próprio. */
export function instantiate(loaded: Loaded): THREE.Object3D {
  return cloneSkinned(loaded.scene);
}

/**
 * TODAS as malhas com pele de um grafo, na ordem em que aparecem.
 *
 * Uma peça deste pacote quase nunca é uma malha só: o `top` do casual traz o
 * pano E OS BRAÇOS (material `Skin`) como primitivos separados, e o
 * `GLTFLoader` transforma cada primitivo numa `SkinnedMesh` irmã. São 74 das 83
 * peças. Pegar só a primeira é o que deixou todo avatar do jogo **sem braços**
 * e todo tênis sem sola — o pano é o primeiro primitivo do arquivo e a pele
 * vinha depois.
 */
export function findAllSkinned(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const found: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) found.push(o as THREE.SkinnedMesh);
  });
  return found;
}

/** A primeira malha com pele — a que carrega o esqueleto que as outras adotam. */
export function findSkinned(root: THREE.Object3D): THREE.SkinnedMesh | null {
  return findAllSkinned(root)[0] ?? null;
}
