import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * EXPERIMENTO AvatarV2 — corpo base do Quaternius Universal Base Characters.
 *
 * Não substitui nada. O avatar procedural continua sendo o do jogo; isto existe
 * para responder a UMA pergunta com uma imagem: um corpo base profissional de
 * 14 mil triângulos parece melhor do que o que construímos à mão? Roupa, loja,
 * banco, multiplayer e o rig do jogo não são tocados.
 *
 * O que torna o experimento barato é uma coincidência que vale registrar: o
 * pacote de corpos e a Universal Animation Library do mesmo autor usam o MESMO
 * esqueleto — 65 ossos com os nomes da convenção do Unreal (`pelvis`,
 * `spine_01`, `clavicle_l`, `thigh_r`…). O `AnimationMixer` do three amarra as
 * faixas pelo NOME do nó, então as animações tocam no personagem sem retarget
 * nenhum. O plano previa retargetar Idle, Walk e Dance; não foi preciso.
 */
export interface CharacterV2Options {
  /**
   * Tinte multiplicado SOBRE a textura de pele do pacote. Deixe vazio para o
   * tom que o autor pintou: a textura já traz cor de pele, e multiplicar um
   * segundo tom de pele por cima entrega um boneco cor de tijolo.
   */
  skin?: THREE.ColorRepresentation;
  hair?: THREE.ColorRepresentation;
  /** Penteado do próprio pacote, preso ao osso da cabeça. */
  hairstyle?: string;
  /** Altura alvo em metros; omitir mantém a do pacote. */
  height?: number;
  /**
   * ROUPA modular: arquivos glTF de peças que vestem o mesmo esqueleto.
   *
   * Esta é a descoberta que decide a arquitetura do avatar v2. Os pacotes de
   * roupa da Quaternius trazem `Body`, `Arms`, `Legs`, `Feet`, `Head` e
   * acessórios como malhas separadas, e o esqueleto delas é o MESMO do corpo
   * base — 65 ossos, mesmos nomes, MESMA ORDEM. Então vestir não é deformar
   * geometria nossa em cima de um corpo: é carregar a peça e amarrá-la ao
   * esqueleto que já está lá.
   *
   * É exatamente o guarda-roupa que a loja precisa, e é o oposto do v1, onde
   * cada peça era lofteada das estações do nosso corpo e um portão de 176
   * combinações media o resultado.
   */
  outfit?: string[];
}

export class CharacterV2 {
  readonly root = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  readonly clips = new Map<string, THREE.AnimationClip>();
  /** Altura medida do modelo, antes de qualquer reescala. */
  readonly nativeHeight: number;
  readonly triangles: number;
  readonly bones: number;

  private current: THREE.AnimationAction | null = null;
  private disposables: Array<{ dispose(): void }> = [];

  private constructor(scene: THREE.Object3D, clips: THREE.AnimationClip[], opts: CharacterV2Options) {
    this.root.add(scene);

    const box = new THREE.Box3().setFromObject(scene);
    this.nativeHeight = box.max.y - box.min.y;
    if (opts.height && this.nativeHeight > 1e-3) {
      const k = opts.height / this.nativeHeight;
      scene.scale.setScalar(k);
    }

    let tris = 0;
    let bones = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh || (mesh as unknown as THREE.Mesh).isMesh) {
        const geo = mesh.geometry;
        tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // O rig deforma bem além da bounding box de repouso, e um esqueleto
        // culado no meio de uma dança some da tela.
        mesh.frustumCulled = false;
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          this.tune(mat as THREE.MeshStandardMaterial, opts);
        }
      }
      if ((o as THREE.Bone).isBone) bones++;
    });
    this.triangles = Math.round(tris);
    this.bones = bones;

    this.mixer = new THREE.AnimationMixer(scene);
    for (const clip of clips) this.clips.set(clip.name, clip);
  }

  /**
   * Traz o material do pacote para a faixa do Streampolis. NÃO repinta: as
   * texturas do autor são o que faz o personagem ser bom. O que muda é o que
   * é decisão do renderizador — piso de rugosidade, ambiente contido, e a
   * anisotropia DESLIGADA no cabelo, que é o que reamostra o mapa de ambiente
   * e devolve o texel do sol como quadrado branco no topo da cabeça.
   */
  private tune(mat: THREE.MeshStandardMaterial, opts: CharacterV2Options) {
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
      if (opts.hair) mat.color.set(opts.hair).convertSRGBToLinear();
    } else if (/eye/i.test(name)) {
      mat.roughness = 0.2;
    } else if (opts.skin) {
      // Multiplicado sobre a textura, não no lugar dela: o mapa do pacote traz
      // o desenho do corpo e da roupa base, e trocá-lo por uma cor chapada
      // jogaria fora exatamente o que se está testando.
      mat.color.set(opts.skin).convertSRGBToLinear();
    }
    this.disposables.push(mat);
  }

  static async load(
    id: 'male' | 'female',
    opts: CharacterV2Options = {},
    base = 'assets/character/',
  ): Promise<CharacterV2> {
    const loader = new GLTFLoader();
    const url = (f: string) => new URL(`${base}${f}`, document.baseURI).href;
    const [body, anims, hair] = await Promise.all([
      loader.loadAsync(url(`${id}.glb`)),
      loader.loadAsync(url('animations.glb')).catch(() => ({ animations: [] as THREE.AnimationClip[] })),
      opts.hairstyle
        ? loader.loadAsync(url(`${opts.hairstyle}.glb`)).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (hair) CharacterV2.attachHair(body.scene, hair.scene);
    if (opts.outfit?.length) {
      const parts = await Promise.all(
        opts.outfit.map((f) => loader.loadAsync(url(f)).catch(() => null)),
      );
      CharacterV2.dress(body.scene, parts.map((p) => p?.scene ?? null));
    }
    return new CharacterV2(body.scene, anims.animations, opts);
  }

  /**
   * Prende um penteado do pacote ao osso da cabeça.
   *
   * Os arquivos "Origin at 0" vêm posicionados no espaço do MODELO — a malha
   * já está onde a cabeça está, com a origem no chão. Pendurá-los no osso sem
   * mais nada aplicaria a transformação da cabeça duas vezes; pré-multiplicar
   * pela INVERSA da matriz de repouso do osso cancela a primeira, e a partir
   * daí o cabelo segue a cabeça como qualquer filho.
   */
  private static attachHair(body: THREE.Object3D, hair: THREE.Object3D) {
    let head: THREE.Bone | null = null;
    body.traverse((o) => { if ((o as THREE.Bone).isBone && o.name === 'Head') head = o as THREE.Bone; });
    if (!head) return;
    body.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy((head as THREE.Bone).matrixWorld).invert();
    hair.applyMatrix4(inverse);
    (head as THREE.Bone).add(hair);
  }

  /**
   * Veste peças no esqueleto que já existe.
   *
   * A peça vem com um esqueleto próprio dentro do arquivo dela; o que se faz
   * aqui é DESCARTAR esse esqueleto e amarrar a malha ao do corpo. Só funciona
   * porque a ordem dos ossos é idêntica — `skinIndex` de uma peça aponta para
   * a mesma articulação nas duas. Ordem diferente exigiria remapear índice por
   * índice, e é a primeira coisa a conferir num pacote novo.
   */
  private static dress(body: THREE.Object3D, parts: Array<THREE.Object3D | null>) {
    let host: THREE.SkinnedMesh | null = null;
    body.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh && !host) host = o as THREE.SkinnedMesh; });
    if (!host) return;
    const base = host as THREE.SkinnedMesh;

    for (const part of parts) {
      if (!part) continue;
      const meshes: THREE.SkinnedMesh[] = [];
      part.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh); });
      for (const mesh of meshes) {
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // Mesma pose de repouso do corpo: a matriz de bind da peça é a dela,
        // e usar a do corpo é o que alinha as duas no mesmo espaço.
        base.parent?.add(mesh);
        mesh.bind(base.skeleton, base.bindMatrix);
      }
    }
  }

  play(name: string, fade = 0.25): boolean {
    const clip = this.clips.get(name);
    if (!clip) return false;
    const next = this.mixer.clipAction(clip);
    next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
    if (this.current && this.current !== next) this.current.crossFadeTo(next, fade, false);
    this.current = next;
    return true;
  }

  update(dt: number) { this.mixer.update(dt); }

  materials(): THREE.Material[] {
    return this.disposables.filter((d): d is THREE.Material => (d as THREE.Material).isMaterial === true);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
