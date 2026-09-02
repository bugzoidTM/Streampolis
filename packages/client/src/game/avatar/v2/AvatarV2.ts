import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import type { AvatarOptions } from '../Avatar.js';
import type { AvatarLike } from '../AvatarLike.js';
import { extraClips } from './Clips.js';
import {
  findAllSkinned, findSkinned, instantiate, loadClips, loadPart, rigOf,
  type PartSlot,
} from './Wardrobe.js';

/**
 * O avatar v2: quatro peças de roupa sobre um esqueleto comum.
 *
 * O v1 gerava corpo, rosto, cabelo e roupa por código, e a conta final foi o
 * dono dizendo que estava feio. O v2 monta o personagem com peças de um pacote
 * profissional — `head`, `top`, `bottom`, `shoes` —, todas do mesmo esqueleto
 * de 62 ossos, todas trocáveis entre si.
 *
 * **Nasce SÍNCRONO e se monta depois.** O laço que lê o estado da sala cria
 * avatares dentro dele e não pode virar assíncrono porque um corpo agora vem de
 * quatro arquivos. O construtor devolve um nó vazio na hora certa, as peças
 * entram quando chegam, e a animação pedida nesse meio-tempo é aplicada na
 * chegada.
 *
 * **O que este corpo NÃO tem**, e é honesto dizer: rosto articulado. O v1
 * piscava, movia o olhar e tinha quatro expressões; aqui a cabeça é uma malha
 * do pacote. A troca foi deliberada — um rosto que ninguém achou bonito, com
 * expressões, perde para um rosto que as pessoas aceitam.
 */

/**
 * De estado do jogo para clipe.
 *
 * As 24 faixas do pacote são de jogo de ação — tiro, soco, rolamento, espada —
 * e não incluem DANÇAR, SENTAR, COMEMORAR nem BATER PALMA, que são justamente
 * os gestos de um jogo de live e de vida virtual. Essas quatro são autoradas
 * em `Clips.ts` e entram junto; o resto vem do pacote, que faz locomoção
 * melhor do que nós faríamos.
 */
const CLIP_FOR: Record<AnimState, string> = {
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
  sit: 'Sit',
  wave: 'Wave',
  clap: 'Clap',
  dance: 'Dance',
  celebrate: 'Celebrate',
  giftReact: 'Interact',
  pkWin: 'Celebrate',
  pkLose: 'HitRecieve',
};

/** Velocidade em que os ciclos do pacote foram autorados, em m/s. */
const NATIVE_WALK = 1.4;
const NATIVE_RUN = 3.6;

/** Altura do adulto que o jogo desenha, em metros. */
const GAME_HEIGHT = 1.72;

/**
 * Onde fica o osso da cabeça, como fração da altura total.
 *
 * Num adulto o topo do crânio está uns 13% acima do osso da cabeça — é a
 * calota mais o cabelo. Vale para os 21 personagens porque o esqueleto é o
 * mesmo em todos.
 */
const HEAD_BONE_RATIO = 0.87;

const FADE = 0.2;

/** A peça que veste um slot quando a pedida não existe. */
const FALLBACK: Record<PartSlot, string> = {
  head: 'm_casual_character_head',
  top: 'm_casual_character_top',
  bottom: 'm_casual_character_bottom',
  shoes: 'm_casual_character_shoes',
};

export interface V2Look {
  head: string;
  top: string;
  bottom: string;
  shoes: string;
}

export class AvatarV2 implements AvatarLike {
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<string, THREE.AnimationClip>();
  private action: THREE.AnimationAction | null = null;
  private state: AnimState = 'idle';
  /**
   * A estatura nominal, já com o multiplicador do jogador.
   *
   * Ela precisa estar certa ANTES de as peças chegarem: o `World` constrói a
   * placa de nome com `stature` no mesmo quadro em que cria o avatar, e a
   * placa guarda essa altura para sempre. Nascer com 1,72 fixo punha a placa de
   * um jogador alto seis centímetros DENTRO da cabeça dele.
   */
  private height: number;
  private disposed = false;
  /** Materiais clonados por avatar, para tingir pele e cabelo sem afetar os outros. */
  private materials: THREE.Material[] = [];
  /**
   * O esqueleto clonado deste avatar.
   *
   * `SkeletonUtils.clone` compartilha geometria e material com o protótipo, mas
   * cria um `Skeleton` novo — e o renderizador aloca uma textura de ossos na
   * GPU para cada um. Sem descartá-la, uma praça por onde passam dezenas de
   * figurantes acumula um handle de textura por visitante, e a vitrine da loja
   * (que monta e destrói um avatar por card) vaza um por peça.
   */
  private skeleton: THREE.Skeleton | null = null;

  /**
   * Resolve quando as peças estão em cena.
   *
   * O laço do jogo não espera por isto — o avatar aparece quando aparece. Quem
   * espera é quem tira RETRATO: renderizar um quadro antes das peças chegarem
   * fotografa o chão vazio, e o card da loja fica em branco.
   */
  readonly ready: Promise<void>;

  constructor(
    private readonly config: AvatarConfig,
    look: V2Look,
    private readonly options: AvatarOptions = {},
  ) {
    this.height = GAME_HEIGHT * (config.height ?? 1);
    this.ready = this.assemble(look);
  }

  private async assemble(look: V2Look) {
    const order: Array<[PartSlot, string]> = [
      ['head', look.head], ['top', look.top], ['bottom', look.bottom], ['shoes', look.shoes],
    ];
    const loaded = await Promise.all(order.map(async ([slot, id]) => {
      // Peça desconhecida cai no padrão DAQUELE slot, e não no vazio.
      //
      // Um id que não existe mais no catálogo — item retirado, jogador antigo,
      // migração pela metade — deixaria o avatar sem calça em vez de com a
      // calça errada. O servidor já recusa o que não se possui; aqui o
      // problema é outro, é arquivo que não está lá.
      for (const candidate of [id, FALLBACK[slot]]) {
        if (!candidate) continue;
        try { return { slot, id: candidate, part: await loadPart(candidate) }; } catch { /* tenta o próximo */ }
      }
      return null;
    }));
    if (this.disposed) return;

    // A PRIMEIRA peça que chegar é a dona do esqueleto; as outras se amarram ao
    // dela. Não importa qual seja — todas trazem o mesmo esqueleto inteiro.
    const present = loaded.filter((x): x is NonNullable<typeof x> => x !== null);
    if (!present.length) return;

    const hostRoot = instantiate(present[0].part);
    const host = findSkinned(hostRoot);
    if (!host) return;
    this.root.add(hostRoot);

    for (const { part } of present.slice(1)) {
      const clone = instantiate(part);
      // TODAS as malhas da peça, não só a primeira.
      //
      // Cada primitivo do arquivo vira uma `SkinnedMesh` irmã, e uma peça deste
      // pacote quase nunca tem um primitivo só: o `top` traz o pano num e OS
      // BRAÇOS (material `Skin`) noutro. Ficar com a primeira é o que pôs 21
      // camisas sem braço e 17 tênis sem sola na praça — e ninguém viu, porque
      // a `head`, que é a peça HOSPEDEIRA, entra inteira e por outro caminho.
      for (const mesh of findAllSkinned(clone)) {
        host.parent?.add(mesh);
        // Descarta o esqueleto que veio no arquivo da peça e usa o do corpo. Só
        // funciona porque a ORDEM dos ossos é idêntica nos 21 personagens: o
        // `skinIndex` da peça aponta para a mesma articulação nos dois.
        mesh.bind(host.skeleton, host.bindMatrix);
      }
    }

    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // A sombra é decidida AQUI, na chegada da peça. Apagá-la de fora, no nó
      // que o construtor devolve, é varrer um grupo vazio: o corpo v2 se monta
      // depois, e o que chega depois chega aceso.
      mesh.castShadow = this.options.castShadow !== false;
      mesh.receiveShadow = true;
      // O rig deforma muito além da caixa de repouso: um avatar culado no meio
      // de um gesto some da tela.
      mesh.frustumCulled = false;
      mesh.material = this.tint(mesh.material);
    });

    // A altura vem do ESQUELETO, não da malha.
    //
    // `Box3.setFromObject` numa malha com pele aplica a matriz do mundo sobre a
    // caixa da geometria, e nestes arquivos a geometria mora num espaço
    // esquisito que só as matrizes inversas de bind desfazem: a caixa dá dez
    // mil unidades de altura e o avatar é escalado para zero — some da cena sem
    // um erro sequer. O osso mais alto é uma medida honesta e, como os 21
    // personagens dividem o mesmo esqueleto, é sempre a mesma.
    hostRoot.updateMatrixWorld(true);
    const at = new THREE.Vector3();
    let topBone = 0;
    hostRoot.traverse((o) => {
      if (!(o as THREE.Bone).isBone) return;
      o.getWorldPosition(at);
      topBone = Math.max(topBone, at.y);
    });
    if (topBone > 0.1) {
      // Do osso da cabeça ao alto do crânio ainda falta cabelo e calota; a
      // proporção é fixa porque o esqueleto é o mesmo.
      const native = topBone / HEAD_BONE_RATIO;
      const scale = (GAME_HEIGHT * (this.config.height ?? 1)) / native;
      this.root.scale.setScalar(scale);
      this.height = native * scale;
    }

    this.skeleton = host.skeleton;
    this.mixer = new THREE.AnimationMixer(hostRoot);
    // O rig é o da peça HOSPEDEIRA, que é a dona do esqueleto que todas as
    // outras adotaram. Vestir uma blusa do outro pacote continua valendo — a
    // malha dela é reamarrada a este esqueleto —, e quem decide como o corpo se
    // move é o corpo, não a roupa.
    const rig = rigOf(present[0].id);
    // O corpo JÁ ESTÁ EM CENA aqui. Se o arquivo de animação falhar, seguir sem
    // ele deixa o avatar de pé na pose de bind; deixar a exceção subir aborta a
    // montagem, e aí `play()` nunca roda, `setAnim()` vira no-op silencioso e a
    // praça enche de estátuas — com uma promessa rejeitada por jogador que
    // ninguém observa. As quatro faixas autorais não dependem do arquivo.
    const packClips = await loadClips(rig).catch(() => [] as THREE.AnimationClip[]);
    if (this.disposed) return;
    for (const clip of packClips) {
      this.clips.set(clip.name.replace('CharacterArmature|', ''), clip);
    }
    // As autorais entram DEPOIS e por cima: se um dia o pacote ganhar uma
    // dança, ela vence a nossa só trocando a ordem aqui.
    for (const clip of extraClips(hostRoot)) this.clips.set(clip.name, clip);
    this.play(this.state, 0);
  }

  /**
   * Tinge pele e cabelo sem tocar no resto da roupa.
   *
   * Os materiais do pacote são cores chapadas com nomes falantes — `Skin`,
   * `Hair_Blond`, `Black`, `White`. É por eles que o tom de pele e a cor do
   * cabelo do jogador continuam existindo depois de o corpo virar asset: sem
   * isto, escolher tom de pele viraria escolher uma cabeça, e o catálogo tem
   * 21 cabeças, não 21 tons.
   *
   * O material é CLONADO por avatar — o protótipo é compartilhado por todo
   * mundo que veste a mesma peça, e tingir o original pintaria a praça inteira.
   */
  private tint(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    const one = (m: THREE.Material) => {
      const name = m.name ?? '';
      if (!/skin|hair/i.test(name)) return m;
      const copy = m.clone() as THREE.MeshStandardMaterial;
      if (/skin/i.test(name)) copy.color.set(SKIN_TONES[this.config.skinTone % SKIN_TONES.length]);
      else copy.color.set(HAIR_COLORS[this.config.hairColor % HAIR_COLORS.length]);
      copy.color.convertSRGBToLinear();
      this.materials.push(copy);
      return copy;
    };
    return Array.isArray(material) ? material.map(one) : one(material);
  }

  private play(state: AnimState, fade = FADE) {
    // O que pode faltar é o CLIPE, não a chave: `CLIP_FOR` é um Record completo.
    // Sem o segundo `get`, um arquivo de animação que não chegou congela o
    // avatar no estado anterior para sempre.
    const clip = this.clips.get(CLIP_FOR[state]) ?? this.clips.get('Idle');
    if (!clip || !this.mixer) return;
    const next = this.mixer.clipAction(clip);
    next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
    if (this.action && this.action !== next) this.action.crossFadeTo(next, fade, false);
    this.action = next;
  }

  setAnim(state: AnimState): void {
    if (state === this.state) return;
    this.state = state;
    this.play(state);
  }

  animate(dt: number, speed: number): void {
    if (!this.mixer) return;
    if (this.action) {
      // O ciclo é regido pela velocidade DESENHADA, como no v1: é a única coisa
      // que impede uma caminhada de patinar sobre o chão.
      const native = this.state === 'run' ? NATIVE_RUN : this.state === 'walk' ? NATIVE_WALK : 0;
      this.action.timeScale = native > 0 ? THREE.MathUtils.clamp(speed / native, 0.4, 2.2) : 1;
    }
    this.mixer.update(dt);
  }

  get stature(): number {
    return this.height;
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.action = null;
    this.clips.clear();
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.skeleton?.dispose();
    this.skeleton = null;
    // Geometria e materiais originais são do PROTÓTIPO em cache, compartilhado
    // com todo avatar que veste a mesma peça: descartá-los aqui apagaria os
    // outros da tela.
    this.root.clear();
  }
}

/** Mesmos tons do criador de avatar; ver `state/avatarOptions.ts`. */
const SKIN_TONES = [
  '#f6dcc8', '#f0cdb0', '#e5b596', '#d29b78',
  '#b87d5b', '#95603f', '#6f452c', '#4d2f1e',
];

const HAIR_COLORS = [
  '#1b1614', '#3a2a20', '#6b452a', '#a8703c',
  '#d9a441', '#e8dcc8', '#8f2f3f', '#2f5fa8',
  '#6b2fa8', '#2fa87e',
];
