import type * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';

/**
 * O contrato que o MUNDO exige de um personagem — e nada além dele.
 *
 * Existe para preparar a troca por um corpo comprado (o experimento AvatarV2,
 * com o corpo base do Quaternius) sem que essa troca vire uma cirurgia no
 * `World`. Hoje há uma implementação só, a procedural; a diferença é que agora
 * o mundo depende desta interface e de um construtor único
 * ({@link createAvatar}), em vez de instanciar a classe concreta em quatro
 * lugares.
 *
 * A superfície é deliberadamente MÍNIMA: é o que o laço de jogo realmente usa.
 * Tudo o que só o avatar procedural sabe fazer — reconstruir guarda-roupa,
 * trocar expressão, medir estação de corpo — fica fora, porque um corpo de
 * pacote não sabe fazer nada disso e fingir que sabe é o que transforma uma
 * interface em mentira.
 */
export interface AvatarLike {
  /** Nó que vai para a cena. */
  readonly root: THREE.Object3D;
  /** Altura dos olhos, em metros: enquadramento de câmera e placa de nome. */
  readonly eyeHeight: number;
  /** Estado de animação pedido pelo servidor. */
  setAnim(state: AnimState): void;
  /** Avança um quadro. `speed` é a velocidade horizontal medida, em m/s. */
  animate(dt: number, speed: number): void;
  dispose(): void;
}

/**
 * De onde vem o corpo de um jogador.
 *
 * `v1` é o avatar procedural: o corpo é gerado, o guarda-roupa é lofteado das
 * estações dele e o portão de 176 combinações mede contra ele.
 *
 * `v2` está RESERVADO para o corpo base do Quaternius, e não é jogável ainda —
 * o guarda-roupa inteiro depende do corpo v1, e um jogador de corpo v2 ficaria
 * sem roupa nenhuma. O valor existe aqui, e é validado no servidor contra
 * posse de item, para que o dia em que ele for vendido seja um dia de
 * catálogo e de vestuário, não um dia de refatoração.
 */
export type BodyKind = 'v1' | 'v2';
