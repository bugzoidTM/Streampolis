import * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';
import type { AvatarLike } from '../AvatarLike.js';
import { loadKit, instantiate, type CharacterKit, type KitSpec } from './Kit.js';

/**
 * O corpo v2 vestindo o contrato do mundo.
 *
 * O experimento anterior provou que o corpo base do Quaternius desenha melhor
 * e que a biblioteca de animação do mesmo autor toca nele sem retarget. O que
 * faltava era isto: um objeto que o `World` consiga usar sem saber de nada
 * disso — mesma interface do procedural, `root`, `eyeHeight`, `setAnim`,
 * `animate`, `dispose`.
 *
 * **Ele nasce SÍNCRONO e chega depois.** É o detalhe que decide se a troca é
 * uma linha ou uma refatoração: o mundo cria avatares dentro do laço que lê o
 * estado da sala, e esse laço não pode virar assíncrono porque um corpo agora
 * vem de um arquivo. Então o construtor devolve um nó vazio na hora certa, o
 * kit entra nele quando termina de carregar, e a animação pedida enquanto
 * isso fica guardada e é aplicada na chegada. Um jogador que aparece a 300 ms
 * de distância é melhor do que um laço de jogo que espera rede.
 *
 * O que este corpo NÃO faz, e não finge fazer: guarda-roupa. As 45 peças são
 * lofteadas das estações do corpo v1 e o portão de 176 combinações mede contra
 * ele. Um v2 usa a roupa que o autor pintou na textura — por isso ele é um
 * ITEM à parte no catálogo e não um botão de aparência.
 */

/**
 * De estado do jogo para clipe do pacote.
 *
 * O pacote traz oito faixas e o protocolo tem onze estados; o que sobra cai no
 * vizinho mais próximo em vez de travar numa pose de repouso. `Interact` é o
 * gesto genérico — é ele que responde por acenar, bater palma e reagir a um
 * presente até existir faixa própria.
 */
const CLIP_FOR: Record<AnimState, string> = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  run: 'Jog_Fwd_Loop',
  sit: 'Sitting_Idle_Loop',
  wave: 'Interact',
  clap: 'Interact',
  dance: 'Dance_Loop',
  celebrate: 'Dance_Loop',
  giftReact: 'Interact',
  pkWin: 'Dance_Loop',
  pkLose: 'Idle_Talking_Loop',
};

/**
 * Velocidade em que cada ciclo de locomoção do pacote foi autorado, em m/s.
 *
 * **Não medida ainda** — e está escrito aqui em vez de escondido num número
 * mágico. No corpo v1 estes valores não são chute: o compilador de clipes MEDE
 * o deslizamento do pé e o relatório sai no `.json` da captura. As faixas do
 * pacote são in-place (não têm movimento de raiz), então medir exige derivar a
 * passada do osso do pé, e isso é trabalho do dia em que o v2 for jogável.
 * Até lá o pé desliza um pouco, e é melhor que a alternativa: um ciclo de
 * caminhada em velocidade fixa, que desliza sempre.
 */
const NATIVE_WALK = 1.45;
const NATIVE_RUN = 3.4;

/** Proporção da altura do corpo onde ficam os olhos, para placa e câmera. */
const EYE_RATIO = 0.935;

const FADE = 0.22;

export class AvatarV2 implements AvatarLike {
  readonly root = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private clips = new Map<string, THREE.AnimationClip>();
  private action: THREE.AnimationAction | null = null;
  private state: AnimState = 'idle';
  private height: number;
  private disposed = false;

  constructor(private readonly config: AvatarConfig, spec?: Partial<KitSpec>) {
    // Enquanto o arquivo não chega, a altura vem do preset: a placa de nome e
    // o enquadramento da câmera perguntam isto no primeiro quadro, e devolver
    // zero põe o nome no chão.
    this.height = 1.67 * (config.height ?? 1);

    loadKit({
      // O pacote gratuito traz DOIS corpos e ambos na proporção "Superhero";
      // escolher por preset de rosto é o que existe hoje para não deixar todo
      // mundo com o mesmo corpo. Quando houver mais corpos isto vira catálogo.
      id: spec?.id ?? (config.facePreset % 2 === 0 ? 'female' : 'male'),
      hairstyle: spec?.hairstyle ?? 'hair_parted',
      hairColor: spec?.hairColor,
    }).then((kit) => this.adopt(kit)).catch((err) => {
      console.warn('[avatar/v2] corpo não carregou; o jogador fica invisível:', err);
    });
  }

  private adopt(kit: CharacterKit) {
    // A promessa do kit pode chegar depois de o jogador ter saído da sala.
    if (this.disposed) return;

    const body = instantiate(kit);
    if (kit.height > 1e-3 && this.config.height) {
      body.scale.setScalar((1.67 * this.config.height) / kit.height);
    }
    this.root.add(body);
    this.height = kit.height * body.scale.y;

    this.mixer = new THREE.AnimationMixer(body);
    for (const clip of kit.clips) this.clips.set(clip.name, clip);
    // O estado pedido durante o carregamento não se perde: quem entrou
    // correndo entra correndo.
    this.play(this.state, 0);
  }

  private play(state: AnimState, fade = FADE) {
    const clip = this.clips.get(CLIP_FOR[state] ?? 'Idle_Loop');
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
    // Mesma regra do corpo procedural: o ciclo é regido pela velocidade que
    // está sendo DESENHADA, não por um relógio. É a única coisa que impede uma
    // caminhada de patinar sobre o chão.
    if (this.action) {
      const native = this.state === 'run' ? NATIVE_RUN : this.state === 'walk' ? NATIVE_WALK : 0;
      this.action.timeScale = native > 0 ? THREE.MathUtils.clamp(speed / native, 0.35, 2.4) : 1;
    }
    this.mixer.update(dt);
  }

  get eyeHeight(): number {
    return this.height * EYE_RATIO;
  }

  dispose(): void {
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.action = null;
    this.clips.clear();
    // Geometria, material e textura são DO KIT, compartilhados com todo outro
    // avatar v2 na cena. Descartá-los aqui apagaria os outros da tela.
    this.root.clear();
  }
}
