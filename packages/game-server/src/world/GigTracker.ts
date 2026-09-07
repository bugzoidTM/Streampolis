import { GIG_STOP_RADIUS } from '../shared.js';
import type { ApiGateway, GigCheckpointResult, GigRunSnapshot } from '../api/ApiGateway.js';

/**
 * Quem vê o jogador chegar na parada.
 *
 * Um bico é uma rota pelo bairro (PRD §26, `shared/gigs.ts`), e cumprir uma
 * parada é estar perto dela. "Estar perto" é uma pergunta sobre POSIÇÃO, e
 * posição é deste processo — ele tem o socket e integra o movimento. A API não
 * sabe onde ninguém está, e não deve saber: uma chegada contada pelo navegador
 * é uma entrega teletransportada.
 *
 * Mas a autoridade aqui para na proximidade. Se aquela é a parada da vez, se a
 * corrida é daquela pessoa, se o prazo venceu e quanto ela vale são perguntas
 * da API, e é ela quem paga. Este rastreador é um SENSOR — ele reporta, não
 * decide.
 *
 * ## Três decisões de custo, e o que cada uma evita
 *
 *   * **amostra a 4 Hz, não a cada tique.** A 24 tiques por segundo, uma
 *     distância por jogador por tique é trabalho para nada: ninguém atravessa
 *     um raio de 2,6 m em 250 ms andando (a velocidade de caminhada do jogo não
 *     chega a 3 m/s, o que dá 75 cm no intervalo);
 *   * **uma chamada em voo por jogador.** Sem a trava, quem PARA em cima da
 *     parada dispara um POST a cada amostragem enquanto a resposta não volta —
 *     e a API responderia "fora de ordem" a todas menos a primeira, depois de
 *     ter feito o trabalho de todas;
 *   * **quem não tem corrida não custa nada.** O mapa só tem quem está
 *     correndo um bico; a varredura de um bairro cheio de gente parada é o
 *     tamanho desse mapa, não o da sala.
 */

const SAMPLE_EVERY_TICKS = 6;

interface Tracked {
  gigId: string;
  stopIndex: number;
  x: number;
  z: number;
  /** Uma chamada em voo por jogador — ver a nota de custo no topo. */
  pending: boolean;
}

export interface GigProgress {
  userId: string;
  result: GigCheckpointResult;
}

export class GigTracker {
  private readonly runs = new Map<string, Tracked>();
  private ticks = 0;

  constructor(
    private readonly api: ApiGateway,
    /** Chamado quando a API aceita uma chegada; a sala avisa o cliente. */
    private readonly onProgress: (progress: GigProgress) => void,
  ) {}

  /**
   * Perguntar à API se esta pessoa já está correndo um bico.
   *
   * Chamado quando alguém entra no bairro e de novo quando o cliente avisa que
   * aceitou um bico (`MSG.gigSync`). O aviso do cliente é só isto — um "vá
   * perguntar de novo" —, nunca a corrida em si: o navegador não é autoridade
   * sobre qual bico ele está fazendo, do mesmo jeito que não é sobre a
   * decoração da casa (ver `MSG.redecorate`).
   */
  async adopt(userId: string): Promise<void> {
    const run = await this.api.activeGig(userId);
    this.apply(userId, run);
  }

  forget(userId: string): void {
    this.runs.delete(userId);
  }

  /** A parada da vez de alguém, para a sala desenhar ou depurar. */
  target(userId: string): { x: number; z: number } | null {
    const t = this.runs.get(userId);
    return t ? { x: t.x, z: t.z } : null;
  }

  private apply(userId: string, run: GigRunSnapshot | null): void {
    if (!run || !run.next) { this.runs.delete(userId); return; }
    this.runs.set(userId, {
      gigId: run.gigId,
      stopIndex: run.stopsDone,
      x: run.next.x,
      z: run.next.z,
      pending: false,
    });
  }

  /**
   * Uma passada pelos corredores em corrida.
   *
   * `positions` traz só quem está na sala AGORA. Um jogador que saiu continua
   * no mapa até o `forget`, e ler a posição dele seria ler um fantasma — por
   * isso a varredura é sobre o mapa E a consulta é na sala.
   */
  tick(positions: (userId: string) => { x: number; z: number } | null): void {
    this.ticks++;
    if (this.ticks % SAMPLE_EVERY_TICKS !== 0) return;
    if (this.runs.size === 0) return;

    for (const [userId, run] of this.runs) {
      if (run.pending) continue;
      const pos = positions(userId);
      if (!pos) continue;
      if (Math.hypot(pos.x - run.x, pos.z - run.z) > GIG_STOP_RADIUS) continue;

      run.pending = true;
      void this.api.gigCheckpoint(userId, run.gigId, run.stopIndex)
        .then((result) => {
          // A corrida pode ter sumido enquanto a chamada estava em voo — o
          // jogador saiu, abandonou pela tela, o prazo venceu. Escrever a
          // resposta num registro que já não existe o ressuscitaria.
          const atual = this.runs.get(userId);
          if (!atual) return;
          atual.pending = false;
          if (!result) return;
          if (result.accepted) {
            this.apply(userId, result.run);
            this.onProgress({ userId, result });
          } else if (!result.run) {
            // Nem corrida nem aceite: a API não conhece mais esta corrida.
            this.runs.delete(userId);
          }
        })
        .catch(() => {
          const atual = this.runs.get(userId);
          if (atual) atual.pending = false;
        });
    }
  }
}
