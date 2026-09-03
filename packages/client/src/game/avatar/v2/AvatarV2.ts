import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import type { AvatarOptions } from '../Avatar.js';
import type { AvatarLike } from '../AvatarLike.js';
import { extraClips } from './Clips.js';
import { FaceV2 } from './FaceV2.js';
import { MouthV2, type MouthState } from './MouthV2.js';
import { isSkinMaterial, smoothNormals, smoothSkinAngle } from './SmoothSkin.js';
import { finishSkin, paintFace, skinKind } from './SkinV2.js';
import {
  characterOf, clipToBands, columnGaps, dominantBones, findAllSkinned, findSkinned,
  instantiate, LINING, loadClips, loadPart, outfitClearance, posed, rigOf, shrink,
  type Clearance, type PartSlot, type Posed,
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
 * **O rosto** não tem as quatro expressões do v1 — o pacote não dá pálpebra nem
 * lábio separados — mas está VIVO: `FaceV2` pisca, move o olhar e faz a
 * sobrancelha derivar mexendo nos primitivos do olho e da sobrancelha, que vêm
 * separados dentro da malha da cabeça. Um rosto de olho arregalado e imóvel é a
 * diferença entre um personagem e um manequim, e ela aparece em qualquer card
 * da loja.
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

/**
 * Quanto o forro se enfia por baixo das peças vizinhas, em metros.
 *
 * Sem margem o recorte termina exatamente onde a peça começa e o encontro vira
 * uma emenda aberta a cada passo — a perna dobra e a calça sai de cima do vão.
 *
 * Mas margem é superfície ESCONDIDA, e escondida é o que ela deveria ser: cada
 * centímetro a mais é mais forro debaixo de um pano cuja forma ele não conhece,
 * e é de lá que vem quase todo o vazamento que sobra — na cintura, onde a
 * bainha da calça é inclinada e nenhuma medida por faixa a acompanha. Quatro
 * centímetros e meio davam 1,11% de vazamento médio; um e meio dá 0,41%, com a
 * mesma fresta (0,01%) e as mesmas 104 de 104 combinações inteiras no
 * `gate:wardrobe` — inclusive nas vistas de caminhada, que existem no portão
 * justamente para que encurtar a margem não pareça melhoria de graça.
 */
const MARGEM_FORRO = 0.015;

/**
 * Quanto o forro aperta onde NADA o mede, em fração do raio local.
 *
 * É o aperto de fundo, e só ele é um número escolhido: no meio do vão o forro é
 * a perna que se vê, e ali não há peça alguma para caber dentro. Seis por cento
 * é o bastante para ele não encostar por fora de uma bainha que passe perto.
 *
 * Na EMENDA, que é onde ele vazava, quem manda é a peça de cima — ver
 * `outfitClearance` em `Wardrobe.ts`.
 */
const ENCOLHE_MEIO = 0.06;

/**
 * A parede de pano entre o forro e a peça que o cobre, em metros.
 *
 * Oito milímetros: o suficiente para o corpo ficar por dentro sem que a roupa
 * pareça vestida sobre o vazio, e menos do que a folga com que estas peças
 * foram modeladas em volta do corpo do próprio personagem.
 */
const FOLGA_FORRO = 0.008;

/** Em quantos metros, vão adentro, o forro solta da medida da bainha. */
const RAMPA_FORRO = 0.060;

/**
 * O raio mínimo que o forro pode ter, em metros.
 *
 * Nenhuma perna tem dois centímetros de raio. É o batente contra o único jeito
 * de `outfitClearance` errar para o lado perigoso: um vértice de sola ou de
 * fivela que passe rente ao osso puxa o mínimo da faixa para quase zero, e sem
 * batente o forro viraria ali uma navalha.
 */
const PISO_FORRO = 0.02;

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

/** O quadro do rosto, quando existe. Cabeça de capacete não tem. */
const frameDoRosto = (face: FaceV2 | null) => face?.face ?? null;

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
   * O que faz este rosto parecer vivo: piscar, olhar e a deriva da sobrancelha.
   *
   * Nulo no figurante (`options.face === false`) e na cabeça que não tem olho
   * nenhum — capacete de astronauta, viseira do tático. Nos dois casos não há
   * nada a fechar, e fingir que há custaria uma deformação por quadro à toa.
   */
  private face: FaceV2 | null = null;
  /**
   * A boca, que o pacote não tem.
   *
   * Nasce das medidas que o `FaceV2` já descobriu, e por isso só existe onde
   * existe rosto: cabeça sem olho — capacete, viseira — não tem de onde tirar
   * eixo, escala nem altura, e ganharia uma boca no meio do vidro.
   */
  private mouth: MouthV2 | null = null;

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
    const bySlot = new Map<PartSlot, THREE.SkinnedMesh[]>();
    bySlot.set(present[0].slot, findAllSkinned(hostRoot));
    for (const m of findAllSkinned(hostRoot)) this.origem.set(m, present[0].id);

    for (const { slot, id, part } of present.slice(1)) {
      const clone = instantiate(part);
      // TODAS as malhas da peça, não só a primeira.
      //
      // Cada primitivo do arquivo vira uma `SkinnedMesh` irmã, e uma peça deste
      // pacote quase nunca tem um primitivo só: o `top` traz o pano num e OS
      // BRAÇOS (material `Skin`) noutro. Ficar com a primeira é o que pôs 21
      // camisas sem braço e 17 tênis sem sola na praça — e ninguém viu, porque
      // a `head`, que é a peça HOSPEDEIRA, entra inteira e por outro caminho.
      const mine: THREE.SkinnedMesh[] = [];
      for (const mesh of findAllSkinned(clone)) {
        mine.push(mesh);
        this.origem.set(mesh, id);
        host.parent?.add(mesh);
        // Descarta o esqueleto que veio no arquivo da peça e usa o do corpo. Só
        // funciona porque a ORDEM dos ossos é idêntica nos 21 personagens: o
        // `skinIndex` da peça aponta para a mesma articulação nos dois.
        mesh.bind(host.skeleton, host.bindMatrix);
      }
      bySlot.set(slot, mine);
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

    // O FORRO, e só agora: primeiro medir o traje montado, depois tapar.
    await this.line(host, present);
    if (this.disposed) return;

    // EXPERIMENTO, desligado por padrão (`?smoothskin=1`): normal suave só na
    // pele da CABEÇA. A geometria é clonada antes porque ela vem do protótipo
    // em cache, compartilhado com todo avatar que veste a mesma cabeça —
    // suavizar no lugar suavizaria a praça inteira, inclusive quem está
    // desenhando o lado A da comparação. Se um dia virar decisão, o lugar certo
    // é o protótipo, uma vez, e não uma cópia por avatar.
    const anguloSuave = smoothSkinAngle();
    if (anguloSuave > 0) {
      for (const mesh of bySlot.get('head') ?? []) {
        if (!isSkinMaterial(mesh.material)) continue;
        mesh.geometry = mesh.geometry.clone();
        this.suavizados += smoothNormals(mesh.geometry, anguloSuave);
      }
    }

    this.skeleton = host.skeleton;
    // O rosto DEPOIS do tingimento: ele toma a geometria do olho para si, e o
    // tom de pele mexe em material, não em vértice — as duas coisas não se
    // atropelam, mas a ordem deixa claro que o rosto vê a cabeça montada.
    if (this.options.face !== false) {
      const head = bySlot.get('head');
      if (head?.length) {
        this.face = new FaceV2(head, host.skeleton);
        if (this.pinnedBlink !== null) this.face.pinBlink(this.pinnedBlink);
        // LÁBIO e rubor: pintura em cor por vértice, na geometria compartilhada
        // e uma vez só por cabeça — o valor gravado é multiplicador, então ele
        // vale para os oito tons de pele. Vem antes da boca porque é a pele em
        // volta dela, e depois do rosto porque é dele que sai onde é a boca.
        if (frameDoRosto(this.face)) {
          const toHead = host.skeleton.boneInverses[
            host.skeleton.bones.findIndex((b) => b.name === 'Head')
          ];
          for (const mesh of head) {
            if (!skinKind(mesh.material) || !toHead) continue;
            this.pintados += paintFace(mesh.geometry, frameDoRosto(this.face)!, toHead);
          }
        }

        // A boca vem DEPOIS e a partir do que o rosto achou: sem o par de olhos
        // não há eixo, régua nem linha de altura de onde tirá-la. O osso é o do
        // esqueleto DESTE avatar — pendurá-la no osso do protótipo em cache
        // poria a boca de todo mundo na cabeça de quem carregou primeiro.
        const frame = this.face.face;
        const bone = host.skeleton.bones.find((b) => b.name === 'Head');
        if (frame && bone) {
          this.mouth = new MouthV2(
            frame, bone, SKIN_TONES[this.config.skinTone % SKIN_TONES.length],
          );
          // Expressão pedida enquanto as peças ainda vinham: aplica-se agora,
          // sem travessia — a boca nasce com ela, e não atravessando até ela.
          if (this.pendingMouth !== 'neutral') this.mouth.setState(this.pendingMouth);
        }
      }
    }
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
      const pele = skinKind(m);
      if (pele) copy.color.set(SKIN_TONES[this.config.skinTone % SKIN_TONES.length]);
      else copy.color.set(HAIR_COLORS[this.config.hairColor % HAIR_COLORS.length]);
      copy.color.convertSRGBToLinear();
      // O ACABAMENTO da pele vem depois do tom, e é onde o pacote errava: todo
      // material dele nasce com metalness 0,4 — pele de plástico polido — e o
      // segundo material de pele, que o autor separou para dar relevo ao rosto,
      // recebia exatamente a mesma cor do primeiro. Ver `SkinV2.ts`.
      if (pele) finishSkin(copy, pele);
      this.materials.push(copy);
      return copy;
    };
    return Array.isArray(material) ? material.map(one) : one(material);
  }

  /**
   * O FORRO: corpo por baixo, **recortado ao vão e só onde há vão**.
   *
   * Este pacote não tem corpo. As quatro peças SÃO o personagem, e cada
   * personagem foi desenhado como um conjunto fechado: a saia da bruxa para no
   * joelho porque a bota dela sobe até lá. A loja vende as peças separadas,
   * então saia da bruxa com tênis baixo são dezoito centímetros de canela que
   * não existem — enxerga-se o CENÁRIO através do avatar. Na cintura é o mesmo,
   * e ali é entre rigs: blusa feminina desce até 1,06 e calça masculina sobe
   * até 0,97.
   *
   * A primeira tentativa foi vestir o forro inteiro por baixo de tudo, e ela
   * estava errada de um jeito que só o pixel mostrou. O forro é uma PEÇA DE
   * ROUPA fazendo as vezes de corpo, e duas roupas de formatos diferentes sobre
   * as mesmas pernas se atravessam: medindo a área em que o forro vencia o
   * teste de profundidade DENTRO da silhueta do traje, ele aparecia por cima da
   * roupa em 12% da silhueta, em 28 de 30 visuais misturados. Manchas cor de
   * pele no meio da calça, em TODO visual misturado e não só nos poucos que
   * tinham vão: a cura pior do que a doença. `polygonOffset` não resolve porque
   * não é empate de profundidade, é interpenetração de verdade, e encolher o
   * bastante para caber dentro da legging mais justa deixaria pernas de palito
   * justamente onde o forro é a perna que se vê.
   *
   * Então mede-se o traje montado, e o forro entra recortado às faixas de
   * altura em que não há mais nada — o único lugar em que ele tem o direito de
   * aparecer. Visual sem vão nenhum não carrega forro algum, que é o caso dos
   * 21 conjuntos inteiros e portanto dos figurantes da praça.
   *
   * Vem depois da escala do corpo porque as duas medidas — o vão e o
   * encolhimento — são dadas em METROS, e só valem com a malha já do tamanho
   * que ela terá no mundo.
   */
  private async line(host: THREE.SkinnedMesh, present: Array<{ id: string }>) {
    // Um conjunto inteiro é fechado por construção: o autor do pacote desenhou
    // as quatro peças uma para a outra. Nem vale medir.
    if (new Set(present.map((p) => characterOf(p.id))).size < 2) return;

    this.root.updateMatrixWorld(true);
    const vestido: Posed[] = [];
    this.root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) vestido.push(posed(o as THREE.SkinnedMesh));
    });
    const vaos = columnGaps(vestido, this.height);
    if (!vaos.length) return;
    this.vaos = vaos;

    const part = await loadPart(LINING).catch(() => null);
    if (!part || this.disposed) return;

    const clone = instantiate(part);
    const malhas = findAllSkinned(clone);

    // Quanto o traje montado deixa livre em volta de cada membro. Medido AQUI,
    // com o traje já em cena e o forro ainda fora dele: é o que diz onde o
    // forro cabe, e ele não pode entrar na própria medida. Só em volta dos
    // ossos que o forro usa — os outros cinquenta ninguém vai consultar.
    const folgas = outfitClearance(
      vestido, malhas.flatMap((m) => [...dominantBones(m)]),
    );
    this.folgas = folgas;

    for (const mesh of malhas) {
      this.origem.set(mesh, LINING);
      host.parent?.add(mesh);
      mesh.bind(host.skeleton, host.bindMatrix);
      mesh.castShadow = this.options.castShadow !== false;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      // O forro inteiro vira PELE, não importa como o doador chamava seus
      // materiais: onde ele aparece é justamente onde deveria haver corpo, e
      // uma calça preta assomando pelo vão da cintura não é melhor do que o
      // buraco que ela veio tapar.
      mesh.material = this.asSkin(mesh.material);
      mesh.updateMatrixWorld(true);
      clipToBands(mesh, vaos, MARGEM_FORRO);
      // E AFINA até CABER na peça vizinha. O forro é largo — uma calça de
      // alfaiate —, e sem isso ele sai por fora da bainha que deveria estar
      // cobrindo; apertado por um número fixo, vira uma navalha dentro de uma
      // bota larga. Quem dá a medida é o traje.
      shrink(mesh, ENCOLHE_MEIO, {
        clearance: folgas, folga: FOLGA_FORRO, ramp: RAMPA_FORRO, piso: PISO_FORRO,
      });
    }
  }

  /** Tinge tudo com o tom de pele do jogador. Usado só no forro. */
  private asSkin(material: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    const one = (m: THREE.Material) => {
      const copy = m.clone() as THREE.MeshStandardMaterial;
      copy.color.set(SKIN_TONES[this.config.skinTone % SKIN_TONES.length]);
      copy.color.convertSRGBToLinear();
      if (copy.map) copy.map = null;
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

  /**
   * Prende o piscar, e continua valendo se as peças ainda não chegaram: o valor
   * fica guardado e o rosto nasce preso. Sem isso o retrato do card corre uma
   * corrida contra o carregamento das peças, e perde de vez em quando.
   */
  /**
   * De qual PEÇA veio cada malha em cena.
   *
   * O portão do guarda-roupa mede buraco por faixa de altura, e uma faixa vazia
   * diz que falta corpo sem dizer de quem é a culpa. Com isto ele aponta a
   * peça: "a calça termina em 0,97 e a blusa começa em 1,06".
   */
  origins(): Map<THREE.SkinnedMesh, string> {
    return this.origem;
  }

  /**
   * A caixa que UMA PEÇA ocupa no mundo, já deformada pela pose.
   *
   * Existe para o card da loja poder enquadrar o que ele vende. O
   * enquadramento era um chute de altura por tipo — busto para blusa, pés para
   * calçado —, escrito quando o corpo era procedural e o guarda-roupa tinha
   * cinco peças por slot. Com 83 peças de vinte e um personagens, o chute erra
   * por construção: a bota do aventureiro sobe até o joelho e a sandália mal
   * cobre o pé, e o mesmo quadro fixo mostra a bota cortada e a sandália
   * perdida num quadro vazio. Pior: o que enche o card de um calçado é a CALÇA
   * de quem está olhando, porque ela está no caminho e é grande.
   *
   * Medida na malha com pele (`getVertexPosition`), não na caixa da geometria:
   * a geometria é a do kit, na pose de bind, e é compartilhada por todos os
   * avatares em cena.
   *
   * Nulo quando a peça não está em cena — id que não existe, arquivo que não
   * chegou —, e aí quem chama volta ao enquadramento fixo em vez de fotografar
   * o vazio.
   */
  pieceBox(id: string): THREE.Box3 | null {
    const caixa = new THREE.Box3();
    const p = new THREE.Vector3();
    this.root.updateMatrixWorld(true);
    for (const [mesh, origem] of this.origem) {
      if (origem !== id) continue;
      const n = mesh.geometry.getAttribute('position').count;
      for (let i = 0; i < n; i++) {
        mesh.getVertexPosition(i, p);
        caixa.expandByPoint(mesh.localToWorld(p));
      }
    }
    return caixa.isEmpty() ? null : caixa;
  }

  /**
   * As faixas de altura em que o traje não cobria nada e o forro entrou.
   *
   * Existe para o instrumento poder ENQUADRAR a emenda, e para dizer, quando
   * o portão reprova, em que costura foi. A caixa envolvente do forro serviria
   * hoje — `clipToBands` corta a geometria —, mas não servia quando o recorte
   * era só no ÍNDICE e os vértices descartados ficavam onde estavam: a caixa
   * de um punho de dez centímetros ia do tornozelo à cintura, e a sonda que a
   * usava julgava a figura inteira achando que estava de perto. Foi assim que
   * ela aprovou um forro explodido em lascas.
   */
  liningBands(): Array<[number, number]> {
    return this.vaos;
  }

  /**
   * A folga que o traje deixou, por lado do corpo e faixa de altura.
   *
   * É o número em que o forro foi encolhido para caber, e sem ele o portão só
   * sabe dizer que o forro está por cima do pano — não se está por cima porque
   * a medida saiu errada ou porque nem havia medida ali.
   */
  liningClearance(): Clearance | null {
    return this.folgas;
  }

  private vaos: Array<[number, number]> = [];

  private folgas: Clearance | null = null;

  private readonly origem = new Map<THREE.SkinnedMesh, string>();

  /** Quantos vértices o experimento de normal suave mexeu. Zero é experimento desligado. */
  private suavizados = 0;
  /** Quantos vértices ganharam lábio ou rubor. Zero depois da primeira cabeça: a pintura é compartilhada. */
  private pintados = 0;

  /** O que o rosto achou na cabeça — nulo quando não há rosto (figurante, capacete). */
  faceReport(): Record<string, unknown> | null {
    const face = this.face?.describe();
    if (!face) return null;
    // A boca junto: uma boca que não foi criada e uma boca posta atrás da pele
    // dão a mesma imagem, e é este relatório que as separa.
    return {
      ...face,
      boca: this.mouth?.describe() ?? null,
      suavizados: this.suavizados,
      pintados: this.pintados,
    };
  }

  pinBlink(value: number | null): void {
    this.pinnedBlink = value;
    this.face?.pinBlink(value);
  }

  private pinnedBlink: number | null = null;

  get anim(): AnimState {
    return this.state;
  }

  setAnim(state: AnimState): void {
    if (state === this.state) return;
    this.state = state;
    this.play(state);
  }

  /**
   * A expressão da boca. Volta sozinha para `neutral` quem a pediu — aqui ela
   * fica onde foi posta, porque este objeto não conhece o motivo da expressão.
   *
   * Guardado mesmo antes de as peças chegarem: o corpo v2 se monta depois, e um
   * pedido feito no meio do carregamento não pode ser perdido pelo caminho —
   * foi assim que o `pinBlink` teve de aprender a esperar.
   */
  setMouth(state: MouthState): void {
    this.pendingMouth = state;
    this.mouth?.setState(state);
  }

  get mouthState(): MouthState {
    return this.mouth?.state ?? this.pendingMouth;
  }

  /**
   * Fala: a boca se mexe pelo tempo que o TEXTO levaria para ser dito.
   *
   * A duração sai do tamanho da mensagem porque é o único dado que existe — não
   * há áudio, não há fonema, e inventar um protocolo para transportar duração
   * seria caro para uma animação que cada navegador consegue fazer sozinho a
   * partir da mesma `ChatMessage` que todos receberam. Quarenta e cinco
   * milésimos por caractere é a velocidade de leitura em voz alta de um adulto
   * em português; o piso existe porque "oi" também é uma fala, e o teto porque
   * o limite do chat são 200 caracteres e nove segundos de boca mexendo viram
   * um tique.
   *
   * O ESTADO não muda: quem estava sorrindo fala sorrindo. A fala é uma
   * modulação por cima da expressão, e quando acaba a boca já está onde estava.
   */
  speak(text: string, seed = 0): void {
    const segundos = Math.min(4.5, Math.max(0.8, 0.55 + text.length * 0.045));
    this.mouth?.speak(segundos, seed);
  }

  /** A boca está se mexendo agora? É o que uma ferramenta pergunta. */
  get speaking(): boolean {
    return this.mouth?.speaking ?? false;
  }

  private pendingMouth: MouthState = 'neutral';

  animate(dt: number, speed: number): void {
    // O rosto avança MESMO SEM MIXER: ele não depende de clipe nenhum, e um
    // avatar que ainda não recebeu as animações precisa piscar do mesmo jeito.
    this.face?.update(dt);
    this.mouth?.update(dt);
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
    this.face?.dispose();
    this.face = null;
    // A boca é malha e material DESTE avatar — nada dela vem do protótipo em
    // cache —, então ela é descartada de verdade, e não só solta do osso.
    this.mouth?.dispose();
    this.mouth = null;
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
