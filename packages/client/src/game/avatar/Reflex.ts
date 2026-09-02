/**
 * O relógio dos reflexos de um rosto: PISCAR e OLHAR.
 *
 * Ele existia dentro do rig de expressão do corpo procedural, afinado ao longo
 * de várias rodadas de revisão, e nasceu aqui quando o corpo do pacote também
 * precisou dele. Os números não podem viver em dois arquivos: um piscar de
 * 60 ms num corpo e de 90 ms no outro é a praça com duas espécies de gente.
 *
 * O que ele NÃO faz é mexer em geometria. Ele só diz, a cada quadro, quanto o
 * olho está fechado (0 a 1) e para onde ele olha; quem sabe traduzir isso em
 * pálpebra é o rosto de cada corpo — no v1 uma casca de pálpebra que gira, no
 * v2 o próprio primitivo do olho, que é a única geometria de olho que o pacote
 * dá.
 */

/** Fechar é rápido; abrir é o triplo. É essa assimetria que separa um piscar de um obturador. */
export const BLINK_CLOSE = 0.06;
export const BLINK_HOLD = 0.03;
export const BLINK_OPEN = 0.13;
const BLINK_TOTAL = BLINK_CLOSE + BLINK_HOLD + BLINK_OPEN;

export class Reflex {
  /** 0 = olho aberto, 1 = fechado. */
  blink = 0;
  /**
   * Para onde o olhar foi, de −1 a 1 em cada eixo. Os dois olhos JUNTOS.
   *
   * Normalizado de propósito: quem sabe quanto vale "um olho" em metros é o
   * rosto de cada corpo, e um número em unidades de mundo aqui seria certo num
   * corpo e errado no outro.
   */
  readonly gaze = { x: 0, y: 0 };

  /**
   * Fase do piscar, em segundos desde o começo dele; negativa = ainda faltam
   * tantos segundos para o próximo.
   *
   * O primeiro nunca cai no instante zero (o sorteio começa em 1,4 s) porque um
   * quadro é capturado assim, sem tempo passar: o retrato da loja e do feed
   * renderiza UMA vez, e um avatar de olho fechado no card é um defeito que
   * ninguém consegue reproduzir olhando o jogo.
   */
  private phase = -(1.4 + Math.random() * 3.2);
  private readonly to = { x: 0, y: 0 };
  private next = 0.8 + Math.random() * 2.4;
  private pinned: number | null = null;

  /** Prende o piscar num valor. É como o retrato garante o olho aberto, e a régua que mede onde a pálpebra fecha. */
  pin(value: number | null): void {
    this.pinned = value;
    if (value !== null) this.blink = value;
  }

  update(dt: number): void {
    if (this.pinned !== null) {
      this.blink = this.pinned;
    } else {
      this.phase += dt;
      if (this.phase >= BLINK_TOTAL) {
        // Um em cada seis piscares vem em par, como o de gente. Sem isso o
        // intervalo fica regular demais e lê como pisca-pisca de máquina.
        this.phase = Math.random() < 0.17 ? -0.14 : -(2.2 + Math.random() * 3.8);
        this.blink = 0;
      } else if (this.phase < 0) {
        this.blink = 0;
      } else if (this.phase < BLINK_CLOSE) {
        this.blink = this.phase / BLINK_CLOSE;
      } else if (this.phase < BLINK_CLOSE + BLINK_HOLD) {
        this.blink = 1;
      } else {
        const u = (this.phase - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN;
        this.blink = 1 - u * u;
      }
    }

    this.next -= dt;
    if (this.next <= 0) {
      // Sacada: o olho SALTA, não desliza. Amplitude pequena de propósito —
      // isto é o olhar de quem está parado, não de quem procura alguém.
      this.to.x = (Math.random() - 0.5) * 2;
      this.to.y = (Math.random() - 0.5) * 1.05;
      this.next = 1.1 + Math.random() * 2.8;
    }
    const g = 1 - Math.exp(-22 * dt);
    this.gaze.x += (this.to.x - this.gaze.x) * g;
    this.gaze.y += (this.to.y - this.gaze.y) * g;
  }
}
