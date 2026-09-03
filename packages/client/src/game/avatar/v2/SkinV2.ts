import * as THREE from 'three';
import type { FaceFrame } from './FaceV2.js';
import { mouthAnchor } from './MouthV2.js';

/**
 * A PELE do corpo de pacote: acabamento, variação e lábio.
 *
 * Três coisas erradas, e nenhuma delas é geometria:
 *
 * 1. **Metalness 0,4.** Todo material do pacote vem assim, e pele não é metal.
 *    É de onde vinha o brilho de plástico na testa — o mesmo brilho que a
 *    comparação de normal suave (`SmoothSkin.ts`) deixou ainda mais evidente,
 *    e que não é problema de normal nenhum. Pele é dielétrica: metalness zero,
 *    sempre.
 * 2. **Um tom só para dois materiais.** As cabeças do pacote trazem `Skin` E
 *    `Skin_Darker` — o segundo é o painel da frente do rosto, das maçãs ao
 *    queixo, e foi o autor do pacote que o separou. Tingir os dois com a mesma
 *    cor, que é o que se fazia, APAGA a variação que já vinha desenhada. Aqui
 *    ele volta a ser mais escuro, e é isso que dá relevo ao rosto de graça.
 * 3. **Lábio nenhum.** A boca é um traço escuro sobre pele lisa. Um lábio não
 *    precisa de geometria: precisa de um tom um pouco mais vermelho e um pouco
 *    mais escuro em volta do traço.
 *
 * O lábio e o rubor entram como COR POR VÉRTICE, e por dois motivos: não há
 * textura de rosto (o pacote não traz mapa nenhum, é cor chapada por material),
 * e as UVs são de um atlas compartilhado, então pintar por textura pintaria
 * também a camisa de quem veste a mesma peça. Cor por vértice não mexe em
 * posição nem em topologia — a malha continua exatamente a mesma.
 *
 * E ela é MULTIPLICADORA: o valor gravado é quanto escurecer ou avermelhar, não
 * a cor final. É o que faz a mesma pintura servir aos oito tons de pele do
 * jogador, e o que permite pintá-la UMA VEZ na geometria compartilhada por todo
 * mundo que veste aquela cabeça, em vez de uma cópia por avatar.
 */

/** Pele é dielétrica. Ponto. */
const SKIN_METALNESS = 0;
/**
 * Aspereza da pele.
 *
 * 0,415 (o que vem no pacote) é plástico polido — e o brilho que ele põe na
 * testa era metade do que fazia o rosto parecer de brinquedo. Pele humana fica
 * entre 0,6 e 0,8; 0,65 é o ponto em que sobra um brilho de rosto vivo sem o
 * reflexo de boneco. Acima de 0,72 o rosto fica de giz e perde o relevo que o
 * especular estava fazendo de graça.
 */
const SKIN_ROUGHNESS = 0.65;
/** Quanto o painel `Skin_Darker` escurece em relação ao tom escolhido. */
const DARKER_PANEL = 0.88;

/**
 * Multiplicadores da pintura. Leves de propósito: é variação, não maquiagem.
 *
 * A calibração foi feita ao contrário, e é o único jeito que funciona numa
 * malha de poucos polígonos: primeiro com um vermelho escandaloso, para provar
 * que a mancha cai EM VOLTA DA BOCA e não no queixo ou na nuca, e só depois
 * baixando até o ponto em que ela lê como lábio e não como batom. São 28 a 52
 * vértices por cabeça — o rosto não tem resolução para mais que um tom.
 */
const LIP_TINT: [number, number, number] = [1.18, 0.68, 0.66];
const CHEEK_TINT: [number, number, number] = [1.05, 0.95, 0.93];
/** Meia-altura do lábio, em alturas do traço da boca. */
const LIP_H = 3.6;
/** Meia-largura do lábio, em larguras do traço. */
const LIP_W = 0.78;
/** Onde fica o rubor: fração do vão entre os olhos, para o lado e para baixo. */
const CHEEK_AT: [number, number] = [0.62, 0.40];
const CHEEK_R = 0.34;

/**
 * Desliga o acabamento novo, para poder compará-lo com o de antes.
 *
 * Ligado por padrão — isto é decisão, não experimento (metalness 0,4 em pele é
 * defeito, não escolha de estilo). O interruptor existe porque a comparação é
 * o único jeito honesto de calibrar aspereza e pintura: `?skinmat=0` desenha o
 * material como o pacote entrega, e `tools/v2-skin-ab.mjs --param=skinmat`
 * põe os dois lado a lado.
 */
export function skinMaterialEnabled(): boolean {
  if (typeof location === 'undefined') return true;
  const v = new URLSearchParams(location.search).get('skinmat');
  return v === null ? true : v !== '0' && v !== 'false';
}

/** Geometrias já pintadas. A pintura é a mesma para todo avatar daquela cabeça. */
const pintadas = new WeakSet<THREE.BufferGeometry>();

/** O material desta malha é pele — de qualquer um dos dois tipos? */
export function skinKind(material: THREE.Material | THREE.Material[]): 'skin' | 'darker' | null {
  const one = Array.isArray(material) ? material[0] : material;
  const name = one?.name ?? '';
  if (!/skin/i.test(name)) return null;
  return /dark/i.test(name) ? 'darker' : 'skin';
}

/**
 * Dá acabamento de pele a um material já tingido.
 *
 * `tone` é a cor que o jogador escolheu, já aplicada; o que muda aqui é o
 * ACABAMENTO. O painel escuro recebe o mesmo tom, rebaixado — a variação que o
 * pacote desenhou e que um tom só apagava.
 */
export function finishSkin(material: THREE.MeshStandardMaterial, kind: 'skin' | 'darker'): void {
  if (!skinMaterialEnabled()) return;
  material.metalness = SKIN_METALNESS;
  material.roughness = SKIN_ROUGHNESS;
  if (kind === 'darker') material.color.multiplyScalar(DARKER_PANEL);
  material.vertexColors = true;
  material.needsUpdate = true;
}

/**
 * Pinta lábio e rubor na malha, em espaço da cabeça.
 *
 * Idempotente por geometria: a mesma malha é compartilhada por todos os
 * avatares que vestem aquela cabeça, e a pintura é igual para todos eles.
 *
 * Devolve quantos vértices ganharam alguma cor — zero quer dizer que a malha
 * não chega perto do rosto (nuca, pescoço) e não é falha nenhuma.
 */
export function paintFace(
  geometry: THREE.BufferGeometry, frame: FaceFrame, toHead: THREE.Matrix4,
): number {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos || !skinMaterialEnabled()) return 0;
  if (pintadas.has(geometry)) return 0;
  pintadas.add(geometry);

  const boca = mouthAnchor(frame);
  const lipW = boca.halfWidth * 2 * LIP_W;
  const lipH = boca.halfHeight * 2 * LIP_H;
  const cheekSide = frame.span * CHEEK_AT[0];
  const cheekUp = frame.eyes.getComponent(frame.up) - frame.span * CHEEK_AT[1];
  const cheekR = frame.span * CHEEK_R;

  const cor = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  let pintados = 0;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(toHead);
    const side = v.getComponent(frame.side);
    const up = v.getComponent(frame.up);
    const fwd = v.getComponent(frame.forward) * frame.facing;

    let r = 1;
    let g = 1;
    let b = 1;
    // Só a frente do rosto: sem este corte o lábio aparece na NUCA, que está à
    // mesma altura e à mesma distância da linha média.
    if (fwd > frame.front * frame.facing - frame.span * 0.55) {
      const dx = (side - boca.side) / lipW;
      const dy = (up - boca.up) / lipH;
      const lip = Math.max(0, 1 - (dx * dx + dy * dy));
      const cx = (Math.abs(side) - cheekSide) / cheekR;
      const cy = (up - cheekUp) / cheekR;
      const cheek = Math.max(0, 1 - (cx * cx + cy * cy));
      if (lip > 0 || cheek > 0) {
        // Suavizado nas bordas: uma queda linear deixa o contorno do lábio
        // visível como uma mancha de borda dura, que é pior que lábio nenhum.
        const l = lip * lip;
        const c = cheek * cheek * 0.6;
        r = 1 + (LIP_TINT[0] - 1) * l + (CHEEK_TINT[0] - 1) * c;
        g = 1 + (LIP_TINT[1] - 1) * l + (CHEEK_TINT[1] - 1) * c;
        b = 1 + (LIP_TINT[2] - 1) * l + (CHEEK_TINT[2] - 1) * c;
        pintados++;
      }
    }
    cor[i * 3] = r;
    cor[i * 3 + 1] = g;
    cor[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(cor, 3));
  return pintados;
}
