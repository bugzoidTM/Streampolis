import * as THREE from 'three';

/**
 * O progresso de carregamento, e por que ele existe.
 *
 * Entrar no jogo levava vários segundos mostrando uma tela PRETA com uma linha
 * de texto no canto — e o passe de assets, que melhorou a cena, piorou isso:
 * a praça agora busca GLBs e um HDRI antes do primeiro quadro. Uma tela preta
 * que demora não parece que está carregando; parece que travou.
 *
 * O que se mede aqui é real, não uma barra animada por tempo. Duas fontes:
 *
 * - o {@link assetManager}, que é um `LoadingManager` do three compartilhado
 *   por todo carregador de arquivo — ele conta itens carregados sobre itens
 *   pedidos, que é a única contagem honesta que existe;
 * - as FASES, que o mundo anuncia conforme passa por elas.
 *
 * Barra que mente é pior que barra nenhuma: se ela chega a 90% e para, o
 * jogador conclui de novo que travou.
 */
export type LoadPhase = 'connect' | 'assets' | 'scene' | 'compile' | 'ready';

export interface LoadReport {
  phase: LoadPhase;
  label: string;
  /** Progresso total, 0..1. */
  value: number;
}

/**
 * O `LoadingManager` que TODO carregador de arquivo do jogo usa.
 *
 * Compartilhado de propósito: um manager por carregador daria três barras
 * concorrentes, e o jogador tem uma tela só.
 */
export const assetManager = new THREE.LoadingManager();

/** Quanto cada fase vale na barra. Somam 1. */
const WEIGHT: Record<LoadPhase, number> = {
  connect: 0.08,
  assets: 0.46,
  scene: 0.22,
  compile: 0.22,
  ready: 0.02,
};

const ORDER: LoadPhase[] = ['connect', 'assets', 'scene', 'compile', 'ready'];

export class LoadTracker {
  private phase: LoadPhase = 'connect';
  private within = 0;
  private highest = 0;
  private offManager: (() => void) | null = null;

  constructor(private readonly emit: (report: LoadReport) => void) {}

  /** Entra numa fase. O rótulo é o que o jogador lê. */
  begin(phase: LoadPhase, label: string): void {
    this.phase = phase;
    this.within = 0;
    this.emit({ phase, label, value: this.value() });
  }

  /** Progresso dentro da fase corrente, 0..1. */
  step(fraction: number, label?: string): void {
    this.within = THREE.MathUtils.clamp(fraction, 0, 1);
    this.emit({ phase: this.phase, label: label ?? '', value: this.value() });
  }

  /**
   * Liga a fase de assets ao contador de arquivos do three.
   *
   * `onProgress` do manager dá carregados sobre pedidos, e o total CRESCE
   * conforme novos arquivos são descobertos — um GLB pede as texturas dele
   * depois de aberto. Por isso a barra nunca anda para trás: guardamos o maior
   * valor já mostrado.
   */
  followAssets(label: string): void {
    this.begin('assets', label);
    const onProgress = (_url: string, loaded: number, total: number) => {
      this.step(total > 0 ? loaded / total : 0, label);
    };
    assetManager.onProgress = onProgress;
    this.offManager = () => {
      if (assetManager.onProgress === onProgress) assetManager.onProgress = () => {};
    };
  }

  stopFollowingAssets(): void {
    this.offManager?.();
    this.offManager = null;
  }

  private value(): number {
    let done = 0;
    for (const p of ORDER) {
      if (p === this.phase) break;
      done += WEIGHT[p];
    }
    const raw = done + WEIGHT[this.phase] * this.within;
    this.highest = Math.max(this.highest, raw);
    return Math.min(1, this.highest);
  }
}
