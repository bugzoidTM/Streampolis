import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Prop } from '../props/Geometry.js';

/**
 * Assets de terceiros, depois do passe.
 *
 * O pipeline offline (`tools/assets/pass.mjs`) entrega UM GLB por família com
 * cada variante como um nó nomeado — dez árvores num arquivo, não dez arquivos.
 * Aqui cada variante é assada nos mesmos `Prop` que o resto do mundo usa: uma
 * geometria por material, pronta para `instanceProp`. Isso é o que faz um
 * modelo baixado custar o mesmo que um prop procedural: dez árvores viram um
 * draw call por material, e não trinta objetos com trinta matrizes.
 *
 * O que NÃO acontece aqui é decisão de arte. Escala, origem, paleta e material
 * já vieram resolvidos do passe; se uma árvore está com o tom errado, o
 * conserto é na curadoria, não no cliente. Um lugar só decide cada coisa.
 */
export interface CatalogItem {
  id: string;
  family: string;
  pack: string;
  license: string;
  /** Quantas vezes esta variante entra no sorteio de uma família. */
  weight: number;
  size: [number, number, number];
  collider: { kind: string; radius: number; height: number };
}

export class AssetLibrary {
  private families = new Map<string, Map<string, Prop>>();
  private catalog = new Map<string, CatalogItem>();
  private disposables: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];

  /**
   * Carrega famílias em paralelo. Uma família que falhar não derruba as
   * outras: a praça com árvore procedural é pior, não quebrada, e um erro de
   * rede não pode deixar o jogador numa cena vazia.
   */
  static async load(names: string[], base = 'assets/'): Promise<AssetLibrary> {
    const lib = new AssetLibrary();
    const loader = new GLTFLoader();

    const catalogUrl = new URL(`${base}catalog.json`, document.baseURI).href;
    await fetch(catalogUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        for (const item of json?.items ?? []) lib.catalog.set(`${item.family}/${item.id}`, item);
      })
      .catch(() => {});

    await Promise.all(names.map(async (name) => {
      try {
        const url = new URL(`${base}${name}.glb`, document.baseURI).href;
        const gltf = await loader.loadAsync(url);
        lib.families.set(name, lib.bake(gltf.scene));
      } catch (err) {
        console.warn(`[assets] família "${name}" não carregou:`, err);
      }
    }));
    return lib;
  }

  /**
   * Achata a cena do GLB em um `Prop` por variante. A matriz de mundo do nó
   * entra na geometria porque o passe já a usou para apoiar o modelo no chão e
   * centrá-lo — e depois disso ninguém mais deve precisar saber que o
   * exportador de origem escreveu a origem no telhado.
   */
  private bake(scene: THREE.Object3D): Map<string, Prop> {
    const out = new Map<string, Prop>();
    scene.updateMatrixWorld(true);

    for (const node of scene.children) {
      const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
      node.updateMatrixWorld(true);
      const inverse = new THREE.Matrix4().copy(node.matrixWorld).invert();

      node.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          const geo = mesh.geometry.clone();
          // Relativo ao nó da variante, não ao mundo: o `Prop` tem de nascer
          // na origem para ser instanciado em trinta lugares.
          geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
          const list = groups.get(mat);
          if (list) list.push(geo); else groups.set(mat, [geo]);
        }
      });

      const prop: Prop = [];
      for (const [mat, geos] of groups) {
        const geo = AssetLibrary.mergeParts(geos);
        this.tune(mat, !!geo.getAttribute('color'));
        prop.push({ geo, mat, cast: true, receive: true });
        this.disposables.push(geo);
      }
      // O nó do modelo carrega a escala e o offset que o passe calculou; como
      // eles já foram assados na geometria, a matriz do nó tem de sair de cena.
      if (prop.length) out.set(node.name, prop);
    }
    return out;
  }

  /**
   * Junta geometrias preservando COLOR_0.
   *
   * O `merge()` do resto do mundo guarda só posição, normal e UV, porque prop
   * procedural nenhum tem cor por vértice. Os pacotes de vegetação TÊM: é
   * assim que uma copa ganha variação sem uma textura por árvore. Jogar o
   * atributo fora enquanto o material continua com `vertexColors` ligado faz o
   * WebGL ler zero em todo vértice, e a árvore inteira sai PRETA — foi
   * exatamente o que aconteceu na primeira captura do passe.
   */
  private static mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const wanted = ['position', 'normal', 'uv'];
    if (parts.every((g) => g.getAttribute('color'))) wanted.push('color');
    const clean = parts.map((geo) => {
      const flat = geo.index ? geo.toNonIndexed() : geo;
      const out = new THREE.BufferGeometry();
      for (const name of wanted) {
        const attr = flat.getAttribute(name);
        if (attr) out.setAttribute(name, attr);
      }
      if (flat !== geo) geo.dispose();
      return out;
    });
    const merged = mergeGeometries(clean);
    for (const g of clean) g.dispose();
    if (!merged) throw new Error('merge de asset falhou: atributos incompatíveis');
    merged.computeBoundingSphere();
    return merged;
  }

  /** O único ajuste de material feito aqui: o que depende do renderizador. */
  private tune(mat: THREE.Material, hasVertexColor: boolean) {
    const std = mat as THREE.MeshStandardMaterial;
    if (!std.isMeshStandardMaterial) return;
    std.vertexColors = hasVertexColor;
    // A cena tem environmentIntensity própria; o valor de fábrica do glTF
    // (1.0) faz o asset importado brilhar mais que tudo à volta dele.
    std.envMapIntensity = 0.85;
    for (const tex of [std.map, std.emissiveMap]) {
      if (tex) tex.colorSpace = THREE.SRGBColorSpace;
    }
    this.disposables.push(mat);
  }

  has(family: string): boolean { return (this.families.get(family)?.size ?? 0) > 0; }

  ids(family: string): string[] { return [...(this.families.get(family)?.keys() ?? [])]; }

  prop(family: string, id: string): Prop | null {
    return this.families.get(family)?.get(id) ?? null;
  }

  /**
   * A lista de variantes já REPETIDA pelo peso da curadoria.
   *
   * O peso existe porque distribuição uniforme não é o mesmo que boa
   * distribuição: numa praça com nove copas, um pinheiro a cada nove árvores é
   * arborização, e um a cada três é floresta. Quem decide isso é a curadoria,
   * onde o resto das decisões de arte já mora.
   */
  bag(family: string): string[] {
    const out: string[] = [];
    for (const id of this.ids(family)) {
      const n = Math.max(1, Math.round(this.item(family, id)?.weight ?? 1));
      for (let i = 0; i < n; i++) out.push(id);
    }
    return out;
  }

  item(family: string, id: string): CatalogItem | undefined {
    return this.catalog.get(`${family}/${id}`);
  }

  /**
   * Uma cópia da variante, escalada para caber num alvo em metros.
   *
   * Sempre uma CÓPIA, nunca o `Prop` guardado: quem chama assa, instancia e
   * depois chama `disposeProp` — e liberar a geometria compartilhada da
   * biblioteca deixaria a próxima sala sem móvel nenhum. O material continua
   * sendo o mesmo objeto, que é o ponto: dez móveis do mesmo pacote são um
   * material só e, portanto, um draw call por peça e não por parte.
   *
   * `uniform` é o padrão porque escala não uniforme distorce: um sofá 30% mais
   * estreito e não mais raso vira um sofá de brinquedo. Tapete é a exceção — é
   * um retângulo, e um retângulo pode ser esticado.
   */
  fitted(
    family: string,
    id: string,
    target: { w?: number; h?: number; d?: number },
    mode: 'uniform' | 'stretch' = 'uniform',
  ): Prop | null {
    const source = this.prop(family, id);
    const item = this.item(family, id);
    if (!source || !item) return null;

    const axis = [
      target.w && item.size[0] > 1e-4 ? target.w / item.size[0] : null,
      target.h && item.size[1] > 1e-4 ? target.h / item.size[1] : null,
      target.d && item.size[2] > 1e-4 ? target.d / item.size[2] : null,
    ];
    let k: [number, number, number];
    if (mode === 'stretch') {
      const fallback = axis.find((v) => v != null) ?? 1;
      k = axis.map((v) => v ?? fallback) as [number, number, number];
    } else {
      // O MENOR dos fatores pedidos: o modelo tem de caber no bloqueador que o
      // servidor conhece, e nunca transbordar dele.
      const declared = axis.filter((v): v is number => v != null);
      const u = declared.length ? Math.min(...declared) : 1;
      k = [u, u, u];
    }

    const m = new THREE.Matrix4().makeScale(k[0], k[1], k[2]);
    return source.map((part) => {
      const geo = part.geo.clone();
      geo.applyMatrix4(m);
      geo.computeBoundingSphere();
      return { ...part, geo };
    });
  }

  /** Todo material carregado, para a cena registrá-los nas sombras em cascata. */
  materials(): THREE.Material[] {
    return this.disposables.filter((d): d is THREE.Material => (d as THREE.Material).isMaterial === true);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.families.clear();
  }
}
