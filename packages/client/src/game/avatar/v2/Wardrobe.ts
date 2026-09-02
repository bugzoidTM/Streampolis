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
