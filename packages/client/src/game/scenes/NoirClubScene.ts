import * as THREE from 'three';
import { NOIR_CLUB, type CrowdRoutine } from '@streampolis/shared';
import { LOOK_INTERIOR } from '../Renderer.js';
import { ROOM_DAY } from '../Environment.js';
import { AmbientCrowd } from '../AmbientCrowd.js';
import { InteriorScene, type InteriorStyle } from './InteriorScene.js';
import type { QualityTier } from '../QualityManager.js';

/**
 * O Clube Sombra (PRD §6, §34): o avesso da rua que leva até ele.
 *
 * A avenida lá fora é preto e branco, chuva e um vermelho só. Aqui é claro,
 * saturado e quente. O contraste não é variedade por variedade — é o que faz
 * atravessar a porta significar alguma coisa. Um interior com a luz da rua
 * seria a mesma cena com teto.
 *
 * ## "Bem iluminado" contraria o clichê, e foi de propósito
 *
 * Discoteca de referência é escura, com feixes cortando fumaça. Este salão é
 * claro: a lavagem da casa cobre o chão inteiro e os feixes coloridos entram
 * POR CIMA dela, como acento. É a lição que a arena já tinha deixado escrita —
 * sem lavagem própria, quem não está debaixo de um feixe vira silhueta. Num
 * lugar cujo ponto é ver gente dançando e conversando, isso seria o defeito
 * central, não um detalhe de gosto.
 *
 * ## O DJ e a pista
 *
 * O DJ é um figurante atrás da cabine, virado para o salão; os dançarinos são
 * figurantes com o gesto `dance` (o quinto tipo de rotina, que nasceu aqui —
 * os outros quatro são jeitos de estar parado, e um clube cheio de gente em pé
 * é um saguão com música). Eles ficam nas BORDAS da pista de propósito: o
 * centro é do jogador, e uma pista pré-ocupada por NPCs é um lugar onde não
 * sobra espaço para dançar.
 *
 * **Não há som.** O jogo não tem sistema de áudio nenhum (SPECs §48 continua
 * por fazer: não existe `AudioListener` em lugar algum do cliente), e música
 * de verdade é decisão de licenciamento antes de ser de código. O que existe
 * aqui é a leitura visual de uma pista tocando — luz pulsando no compasso,
 * corpos dançando, as caixas de som e o LED atrás do DJ.
 */

/** Batidas por minuto do pulso das luzes. 124 é house de pista, e é rápido o
 *  bastante para ler como música sem virar estroboscópio. */
const BPM = 124;

const CLUB_STYLE: InteriorStyle = {
  look: {
    ...LOOK_INTERIOR,
    exposure: 1.02,
    saturation: 1.3,
    contrast: 1.06,
    bloomStrength: 0.55,
    vignette: 0.26,
  },
  lighting: {
    // A base é a do DIA, e não a da noite, apesar de o clube ser noturno.
    //
    // A primeira versão partiu de `ROOM_NIGHT` com chave fraca e paredes quase
    // pretas — e o resultado foi uma sala escura, que é exatamente o contrário
    // do pedido. "Bem iluminado" não se resolve somando holofotes coloridos
    // num quarto preto: os feixes acendem só o que tocam e o resto continua
    // buraco. Quem levanta o piso da imagem é o AMBIENTE, e é ele que precisa
    // ser alto aqui.
    ...ROOM_DAY,
    keyDirection: [0.2, -0.85, 0.4],
    keyColor: 0xfff0e2,
    keyIntensity: 2.1,
    keyRadius: 18,
    ambientIntensity: 1.05,
    ceilingColor: 0x6a4f9e,
    envTop: 0xc0a8f0, envSide: 0x9a7ac0, envWindow: 0xffb8e0,
    fogNear: 30, fogFar: 110,
  },
  screen: [0xff3d9a, 0x2fd8ff],
  // Feixes visíveis: certo para um palco, e este salão é um palco inteiro.
  beams: true,
  practicals: 1.25,
  shell: (lib) => ({
    // Superfícies CLARAS o bastante para devolver luz. Um chão quase preto
    // engole tudo o que os holofotes jogam nele e a sala fica escura por mais
    // lâmpadas que se pendure — foi o que aconteceu na primeira versão.
    // Polido, isso sim: é o que devolve a cor das luzes, como o asfalto
    // molhado devolve o néon lá fora.
    floor: lib.paving('#6f6486', '#4a4260'),
    wall: lib.plaster('#7a6a9c'),
    ceiling: lib.painted(0x4a3a70, 0.8),
    trim: lib.metal('#d8bcf0', 0.35, 0.85),
    floorTile: 1.6,
    wallTile: 2.2,
    view: { top: 0x6a4f9e, bottom: 0x4a3a70, sun: 0xffb8e0 },
  }),
};

/**
 * Quem está no clube.
 *
 * Nas bordas da pista, nunca no meio: o centro é do jogador. Um par no bar e
 * outro no lounge fazem o lugar parecer que já estava acontecendo antes de
 * alguém chegar — que é a única coisa que um figurante precisa fazer.
 */
const CROWD: CrowdRoutine[] = [
  // O DJ, atrás da cabine e virado para o salão.
  { kind: 'watch', path: [{ x: 0, z: -11.2 }], facing: 0 },

  // A pista, pelas beiradas.
  { kind: 'dance', path: [{ x: -5.2, z: -4.6 }], facing: 0.3 },
  { kind: 'dance', path: [{ x: 5.0, z: -5.2 }], facing: -0.2 },
  { kind: 'dance', path: [{ x: -4.4, z: 2.4 }], facing: 2.6 },
  { kind: 'dance', path: [{ x: 4.8, z: 3.0 }], facing: 3.4 },
  { kind: 'dance', path: [{ x: -1.6, z: 4.2 }], facing: 3.0 },
  { kind: 'dance', path: [{ x: 2.2, z: -7.0 }], facing: 0.1 },

  // No bar, de costas para a pista: quem está no bar não está na pista.
  { kind: 'talk', path: [{ x: -10.8, z: -2.6 }], facing: -Math.PI / 2 + 0.3 },
  { kind: 'talk', path: [{ x: -10.8, z: -1.0 }], facing: -Math.PI / 2 - 0.3 },

  // No lounge, de frente um para o outro — lado a lado leria como fila.
  { kind: 'talk', path: [{ x: 11.6, z: -5.4 }], facing: -Math.PI / 2 },
  { kind: 'talk', path: [{ x: 9.6, z: -5.4 }], facing: Math.PI / 2 },

  // E alguém atravessando, para o salão não ser um quadro parado.
  { kind: 'walk', path: [{ x: -8.4, z: 8.0 }, { x: 0, z: 6.6, wait: 2.4 }, { x: 8.4, z: 7.4 }] },
];

export class NoirClubScene extends InteriorScene {
  private crowd: AmbientCrowd | null = null;
  /** Os holofotes coloridos e a intensidade em que cada um nasceu. */
  private pulsos: Array<{ light: THREE.Light; base: number; fase: number }> = [];
  private tempo = 0;

  constructor() { super('noir_club', NOIR_CLUB, CLUB_STYLE); }

  /**
   * Os figurantes entram por `populate`, e não por `dress`.
   *
   * É o gancho que o `SceneBase` criou para isto e que a praça e a rua já
   * usam: o ORÇAMENTO vem de fora, do gerenciador de qualidade. Numa máquina
   * fraca a pista esvazia antes de a taxa de quadros cair — e um clube com
   * menos gente ainda é um clube, enquanto um clube a 12 fps não é nada.
   */
  override populate(budget: number): void {
    if (budget <= 0 || this.crowd) return;
    this.crowd = new AmbientCrowd(this.scene, CROWD, Math.max(1, budget));
  }

  /** `dress()` é o gancho do `InteriorScene` para o que é só desta sala. */
  protected override dress(): void {
    /**
     * As luzes pulsam no compasso — e é isso que faz o lugar ter música sem ter
     * som. Um salão de discoteca com luz PARADA lê como sala de espera bem
     * decorada; o olho aceita "está tocando" a partir do movimento, não do
     * áudio.
     *
     * Só os feixes COLORIDOS pulsam. A lavagem branca da casa fica firme: se
     * ela piscasse junto, os rostos apagariam no contratempo e o salão viraria
     * o estroboscópio que o pedido de "bem iluminado" recusa.
     */
    this.scene.traverse((o) => {
      const luz = o as THREE.SpotLight;
      if (!(luz as THREE.Light).isLight || luz.intensity <= 0) return;
      const cor = (luz as THREE.SpotLight).color;
      if (!cor) return;
      // Branco quente = luz da casa. Saturado = feixe de pista.
      const hsl = { h: 0, s: 0, l: 0 };
      cor.getHSL(hsl);
      if (hsl.s < 0.45) return;
      this.pulsos.push({ light: luz, base: luz.intensity, fase: this.pulsos.length * 0.9 });
    });
  }

  override update(dt: number, camera: THREE.Camera): void {
    this.tempo += dt;
    this.crowd?.update(dt);

    // Um compasso por batida, com as luzes defasadas entre si: em fase, o
    // salão inteiro acende e apaga junto e vira um pisca-pisca.
    const w = (this.tempo * BPM) / 60 * Math.PI * 2;
    for (const p of this.pulsos) {
      const batida = 0.55 + 0.45 * Math.pow(Math.max(0, Math.sin(w + p.fase)), 3);
      p.light.intensity = p.base * batida;
    }

    super.update(dt, camera);
  }

  override dispose(): void {
    this.crowd?.dispose();
    this.crowd = null;
    this.pulsos = [];
    super.dispose();
  }
}
