import { INTENT_QUEUE_LIMIT, MAX_INTENTS_PER_TICK, TICK_MS } from './protocol.js';

/**
 * O relógio do MOVIMENTO, separado do relógio do desenho.
 *
 * O corpo anda em passos fixos (`TICK_MS`) porque servidor e preditor precisam
 * integrar exatamente a mesma coisa; o navegador, por outro lado, desenha
 * quando consegue. Quem faz a ponte entre os dois é esta classe: recebe o tempo
 * REAL do quadro e devolve quantos passos cabem nele, guardando o resto.
 *
 * O defeito que a motivou: o laço do mundo cortava o quadro em 50 ms antes de
 * passá-lo adiante, e o acumulador da conexão só deixava 4 passos de dívida.
 * O corte menor sempre vencia, então TODO quadro mais longo que 50 ms virava
 * um passo só — e um passo é 41,7 ms. A 4 quadros por segundo o jogador andava
 * a um sexto da velocidade; num engasgo de 300 ms o avatar simplesmente PARAVA
 * enquanto a tecla continuava apertada. Era este o "às vezes ele trava".
 */

/**
 * Teto da dívida, em passos.
 *
 * Não é um número redondo qualquer: é o que o servidor consegue engolir. Ele
 * consome `MAX_INTENTS_PER_TICK` por tique e sua fila tem `INTENT_QUEUE_LIMIT`
 * lugares, então uma rajada de 6 esvazia em dois tiques (83 ms) e ainda deixa
 * meia fila livre para a rajada seguinte. Recuperar MAIS que isso não seria
 * andar mais rápido — seria bater no guarda de enxurrada e ser corrigido de
 * volta, que é o mesmo travamento por outro caminho.
 *
 * O que passa do teto é DESCARTADO de propósito: uma aba que passou meia hora
 * em segundo plano não deve devolver meia hora de caminhada num quadro só.
 */
export const MAX_CATCHUP_STEPS = Math.min(
  6,
  Math.floor(INTENT_QUEUE_LIMIT / MAX_INTENTS_PER_TICK) * MAX_INTENTS_PER_TICK,
);

/**
 * Maior quadro que ainda conta inteiro, em segundos.
 *
 * O laço de desenho corta o quadro por aqui, e é o MESMO limite da dívida: dois
 * cortes diferentes foi exatamente o que criou o defeito acima. Acima disto o
 * tempo é perdido para todo mundo ao mesmo tempo — movimento, animação e
 * efeitos —, em vez de sumir só para o movimento.
 */
export const MAX_FRAME_SECONDS = (TICK_MS * MAX_CATCHUP_STEPS) / 1000;

export class FixedStep {
  private debt = 0;

  constructor(
    private readonly stepMs: number = TICK_MS,
    private readonly maxSteps: number = MAX_CATCHUP_STEPS,
  ) {}

  /** Quantos passos inteiros cabem no tempo real decorrido. O resto fica. */
  advance(dtSeconds: number): number {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0;
    // O teto é aplicado ANTES de drenar: é a dívida que é limitada, não a
    // saída. Limitar a saída deixaria o resto guardado e o quadro seguinte
    // devolveria a mesma rajada de novo, para sempre.
    this.debt = Math.min(this.debt + dtSeconds * 1000, this.stepMs * this.maxSteps);
    let steps = 0;
    while (this.debt >= this.stepMs) {
      this.debt -= this.stepMs;
      steps++;
    }
    return steps;
  }

  /** Zera a dívida. Usado ao trocar de sala: tempo velho não vira passo novo. */
  reset(): void {
    this.debt = 0;
  }
}
