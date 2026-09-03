import * as THREE from 'three';

/**
 * Normais suaves na PELE da cabeça — um experimento, com interruptor.
 *
 * As cabeças do pacote são de sombreamento chapado: cada face tem os quatro
 * vértices só dela, com a normal dela, e é isso que dá o desenho facetado do
 * jogo inteiro. A pergunta que este arquivo existe para responder é estreita:
 * **suavizar a normal SÓ da pele do rosto melhora ou estraga?** Um rosto tem
 * curvas que um ombro não tem — bochecha, testa, queixo —, e é plausível que
 * ali a faceta atrapalhe. Também é plausível que ela seja justamente o estilo.
 *
 * Por isso nada aqui liga sozinho: `?smoothskin=1` na URL desenha o rosto
 * suavizado, `?smoothskin=0` (o padrão) desenha o de sempre, e
 * `tools/v2-skin-ab.mjs` põe os dois lado a lado. Decidir por memória, ou por
 * uma captura só, é como se adota um estilo por engano.
 *
 * ## Por que não é `mergeVertices` seguido de `computeVertexNormals`
 *
 * Porque `mergeVertices` só funde vértices iguais em TODOS os atributos, e numa
 * malha chapada as normais são justamente o que difere: não funde nada. E se
 * fundisse, mexeria no índice de uma malha com pele, que é onde `skinIndex` e
 * `skinWeight` moram. O que se faz aqui é o contrário e é seguro: a topologia
 * fica exatamente como está, e só a NORMAL é reescrita — a média das normais
 * de todos os vértices que ocupam o mesmo ponto.
 */

/**
 * O ÂNGULO de suavização pedido pela URL, em graus. Zero é desligado.
 *
 * `?smoothskin=180` funde tudo o que ocupa o mesmo ponto — a suavização total.
 * `?smoothskin=45` funde só o que se encontra em ângulo raso, que é como
 * qualquer pacote de modelagem faz: a bochecha e a testa suavizam, a aresta do
 * nariz e a linha do queixo continuam duras. `?smoothskin=1` é atalho para o
 * total, porque foi assim que o experimento nasceu.
 *
 * Desligado por padrão: isto é experimento, não decisão.
 */
export function smoothSkinAngle(): number {
  if (typeof location === 'undefined') return 0;
  const v = new URLSearchParams(location.search).get('smoothskin');
  if (v === null || v === '0' || v === 'false') return 0;
  if (v === '1' || v === 'true') return 180;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(180, n)) : 0;
}

/** O material desta malha é pele? É por ele que a cabeça se separa do cabelo. */
export function isSkinMaterial(material: THREE.Material | THREE.Material[]): boolean {
  const one = Array.isArray(material) ? material[0] : material;
  return /skin/i.test(one?.name ?? '');
}

/**
 * Suaviza as normais soldando por POSIÇÃO.
 *
 * A tolerância sai do tamanho da própria malha: estas geometrias vivem num
 * espaço em que a cabeça inteira mede milésimos, e um epsilon absoluto que
 * funcione numa cabeça é grosseiro na outra.
 *
 * Devolve quantos vértices foram afetados — zero quer dizer que a malha já era
 * suave, e um relatório que não distingue "suavizei" de "não havia o que
 * suavizar" não serve para decidir nada.
 */
export function smoothNormals(geometry: THREE.BufferGeometry, angleDeg = 180): number {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const nor = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!pos || !nor || pos.count === 0) return 0;

  let extent = 0;
  for (let i = 0; i < pos.count; i++) {
    extent = Math.max(extent, Math.abs(pos.getX(i)), Math.abs(pos.getY(i)), Math.abs(pos.getZ(i)));
  }
  const grid = extent > 0 ? 1 / (extent * 1e-4) : 1e6;

  const chaves: string[] = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    chaves[i] = `${Math.round(pos.getX(i) * grid)},${Math.round(pos.getY(i) * grid)},${Math.round(pos.getZ(i) * grid)}`;
  }

  // Quem divide o ponto com quem. Guardar os ÍNDICES, e não só a soma, é o que
  // permite o ângulo-limite: com a soma pronta não dá mais para perguntar quais
  // vizinhos entram na média deste vértice.
  const vizinhos = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const key = chaves[i] as string;
    const lista = vizinhos.get(key);
    if (lista) lista.push(i); else vizinhos.set(key, [i]);
  }

  const limite = Math.cos((Math.min(180, Math.max(0, angleDeg)) * Math.PI) / 180);
  const original = new Float32Array(nor.count * 3);
  for (let i = 0; i < nor.count; i++) {
    original[i * 3] = nor.getX(i);
    original[i * 3 + 1] = nor.getY(i);
    original[i * 3 + 2] = nor.getZ(i);
  }

  let mexidos = 0;
  const v = new THREE.Vector3();
  for (const lista of vizinhos.values()) {
    if (lista.length < 2) continue;
    for (const i of lista) {
      const nx = original[i * 3] as number;
      const ny = original[i * 3 + 1] as number;
      const nz = original[i * 3 + 2] as number;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let n = 0;
      for (const j of lista) {
        const ox = original[j * 3] as number;
        const oy = original[j * 3 + 1] as number;
        const oz = original[j * 3 + 2] as number;
        // Só entra na média quem encontra este vértice em ângulo raso. É esta
        // linha que separa "a cabeça virou um ovo" de "a bochecha suavizou e a
        // aresta do nariz continua sendo uma aresta".
        if (nx * ox + ny * oy + nz * oz < limite) continue;
        sx += ox; sy += oy; sz += oz; n++;
      }
      if (n < 2) continue;
      v.set(sx, sy, sz);
      if (v.lengthSq() < 1e-12) continue;
      v.normalize();
      nor.setXYZ(i, v.x, v.y, v.z);
      mexidos++;
    }
  }
  nor.needsUpdate = true;
  return mexidos;
}
