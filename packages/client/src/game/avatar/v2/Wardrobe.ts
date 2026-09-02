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

const parts = new Map<string, Promise<Loaded>>();
let clipsPromise: Promise<THREE.AnimationClip[]> | null = null;
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
  parts.set(id, p);
  return p;
}

/**
 * As 24 animações do pacote, num arquivo só.
 *
 * Elas são idênticas nos 21 personagens; guardar uma cópia por peça seria 21
 * vezes o mesmo keyframe. O `AnimationMixer` do three amarra as faixas pelo
 * NOME do nó, então este arquivo sem malha nenhuma anima qualquer combinação.
 */
export function loadClips(): Promise<THREE.AnimationClip[]> {
  clipsPromise ??= loader().loadAsync(url('animations.glb')).then((g) => g.animations);
  return clipsPromise;
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

/** A primeira malha com pele de um grafo — a que carrega o esqueleto. */
export function findSkinned(root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  return found;
}
