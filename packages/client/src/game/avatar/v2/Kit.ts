import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assetManager } from '../../assets/loading.js';

/**
 * O "kit" de um corpo comprado: o arquivo, carregado UMA vez, e os clones que
 * saem dele.
 *
 * Existe porque um corpo de pacote não é como o procedural. O v1 é gerado por
 * jogador e não custa rede nenhuma; o v2 é 1 MB de GLB mais 5 MB de animação,
 * e uma praça com doze pessoas baixaria isso doze vezes se cada avatar
 * chamasse o carregador. Aqui o protótipo é carregado uma vez, os materiais
 * são ajustados uma vez, e cada avatar leva um CLONE do grafo — que é o
 * `SkeletonUtils.clone`, não `Object3D.clone`: só ele refaz o vínculo do
 * esqueleto, e sem isso todos os clones dançam a dança do primeiro.
 *
 * Consequência de posse: geometria, material e textura são do KIT, e o kit
 * vive enquanto a página viver. Um avatar que sai da cena descarta o mixer e o
 * próprio grafo, e NÃO descarta nada disso — descartar mataria os outros.
 */
export interface CharacterKit {
  /** Protótipo. Nunca entra numa cena; só é clonado. */
  readonly prototype: THREE.Object3D;
  readonly clips: THREE.AnimationClip[];
  /** Altura medida do modelo em repouso, em metros. */
  readonly height: number;
}

export interface KitSpec {
  id: 'male' | 'female';
  hairstyle?: string;
  /** Tinte multiplicado sobre a textura do cabelo do pacote. */
  hairColor?: number;
}

const kits = new Map<string, Promise<CharacterKit>>();

const keyOf = (spec: KitSpec) => `${spec.id}|${spec.hairstyle ?? ''}|${spec.hairColor ?? ''}`;

/**
 * Traz o material do pacote para a faixa do Streampolis. NÃO repinta: as
 * texturas do autor são o que faz o personagem ser bom. O que muda é o que é
 * decisão do renderizador — piso de rugosidade, ambiente contido, e a
 * ANISOTROPIA desligada, que é o que reamostra o mapa de ambiente e devolve o
 * texel do sol como quadrado branco no topo da cabeça (o mesmo defeito que o
 * avatar procedural teve, pela mesma causa).
 */
function tune(mat: THREE.MeshStandardMaterial, spec: KitSpec) {
  if (!mat?.isMeshStandardMaterial) return;
  const name = mat.name ?? '';
  mat.envMapIntensity = 0.7;
  mat.roughness = Math.max(0.42, mat.roughness);
  mat.metalness = Math.min(0.05, mat.metalness);

  const phys = mat as THREE.MeshPhysicalMaterial;
  if (phys.isMeshPhysicalMaterial) {
    phys.anisotropy = 0;
    phys.clearcoat = /eye/i.test(name) ? 0.6 : 0;
  }
  if (/hair/i.test(name)) {
    mat.roughness = 0.66;
    mat.envMapIntensity = 0.25;
    if (spec.hairColor !== undefined) mat.color.setHex(spec.hairColor).convertSRGBToLinear();
  } else if (/eye/i.test(name)) {
    mat.roughness = 0.2;
  }
}

/**
 * Prende um penteado do pacote ao osso da cabeça.
 *
 * Os arquivos "Origin at 0" vêm no espaço do MODELO — a malha já está onde a
 * cabeça está, com a origem no chão. Pendurá-los no osso sem mais nada aplica
 * a transformação da cabeça duas vezes; pré-multiplicar pela INVERSA da matriz
 * de repouso do osso cancela a primeira.
 */
function attachHair(body: THREE.Object3D, hair: THREE.Object3D) {
  let head: THREE.Bone | null = null;
  body.traverse((o) => { if ((o as THREE.Bone).isBone && o.name === 'Head') head = o as THREE.Bone; });
  if (!head) return;
  body.updateMatrixWorld(true);
  const bone = head as THREE.Bone;
  hair.applyMatrix4(new THREE.Matrix4().copy(bone.matrixWorld).invert());
  bone.add(hair);
}

export function loadKit(spec: KitSpec, base = 'assets/character/'): Promise<CharacterKit> {
  const key = keyOf(spec);
  const hit = kits.get(key);
  if (hit) return hit;

  // Pelo manager compartilhado: é o que faz a tela de carregamento contar
  // estes arquivos em vez de esperá-los em silêncio.
  const loader = new GLTFLoader(assetManager);
  const url = (f: string) => new URL(`${base}${f}`, document.baseURI).href;

  const promise = Promise.all([
    loader.loadAsync(url(`${spec.id}.glb`)),
    loader.loadAsync(url('animations.glb')).catch(() => ({ animations: [] as THREE.AnimationClip[] })),
    spec.hairstyle ? loader.loadAsync(url(`${spec.hairstyle}.glb`)).catch(() => null) : Promise.resolve(null),
  ]).then(([body, anims, hair]) => {
    const prototype = body.scene;
    if (hair) attachHair(prototype, hair.scene);

    prototype.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // O rig deforma bem além da caixa de repouso, e um esqueleto culado no
      // meio de uma dança some da tela.
      mesh.frustumCulled = false;
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        tune(mat as THREE.MeshStandardMaterial, spec);
      }
    });

    const box = new THREE.Box3().setFromObject(prototype);
    return { prototype, clips: anims.animations, height: box.max.y - box.min.y };
  });

  kits.set(key, promise);
  return promise;
}

/** Um exemplar novo do kit, com esqueleto próprio. */
export function instantiate(kit: CharacterKit): THREE.Object3D {
  return cloneSkinned(kit.prototype);
}
