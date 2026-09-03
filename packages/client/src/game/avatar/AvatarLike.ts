import type * as THREE from 'three';
import type { AnimState, AvatarConfig } from '@streampolis/shared';

/**
 * O contrato que o MUNDO exige de um personagem — e nada além dele.
 *
 * Existiu para PREPARAR a troca do corpo procedural pelo corpo de pacote sem
 * que ela virasse uma cirurgia no `World` — e foi o que aconteceu: a migração
 * v2 mexeu num `if` dentro de {@link createAvatar} e o mundo inteiro passou a
 * desenhar outro corpo, sem que este arquivo mudasse.
 *
 * A superfície é deliberadamente MÍNIMA: é o que o laço de jogo realmente usa.
 * Tudo o que só o avatar procedural sabe fazer — reconstruir guarda-roupa,
 * trocar expressão, medir estação de corpo — fica fora, porque um corpo de
 * pacote não sabe fazer nada disso e fingir que sabe é o que transforma uma
 * interface em mentira.
 *
 * Hoje há DUAS implementações e a padrão é a do pacote ({@link AvatarV2}); a
 * procedural é a rede de segurança da migração.
 */
export interface AvatarLike {
  /** Nó que vai para a cena. */
  readonly root: THREE.Object3D;
  /**
   * A ESTATURA: do chão ao alto do crânio, em metros.
   *
   * O nome importa porque o anterior não tinha um significado só. `eyeHeight`
   * dizia "altura dos olhos" e valia a coroa num corpo (documentada como coroa,
   * na verdade o osso da cabeça, 19 cm abaixo dela) e a linha dos olhos no
   * outro — 0,886 da estatura contra 0,94. As duas implementações discordavam
   * em quase nove centímetros e todo consumidor somava um deslocamento
   * calibrado contra UMA delas: a placa de nome ficou boiando acima da cabeça
   * de todo mundo no dia da migração, e o `PosterStudio` ganhou um `if` sobre o
   * tipo concreto para desfazer a diferença — exatamente a cirurgia que esta
   * interface existe para evitar.
   *
   * Estatura tem um significado só, e quem precisa da linha dos olhos ou do
   * queixo deriva dela.
   */
  readonly stature: number;
  /** Estado de animação pedido pelo servidor. */
  setAnim(state: AnimState): void;
  /**
   * O que este corpo está tocando AGORA.
   *
   * Entrou no contrato porque só o procedural sabia responder: o relatório do
   * mundo (`World.stats().anim`) perguntava ao `Animator`, que o corpo de
   * pacote não tem, e devolvia `'idle'` para todo mundo desde a migração — uma
   * ferramenta que quisesse provar que um gesto atravessou a rede leria
   * "parado" com o avatar dançando na tela.
   */
  readonly anim: AnimState;
  /** Avança um quadro. `speed` é a velocidade horizontal medida, em m/s. */
  animate(dt: number, speed: number): void;
  /**
   * Prende o piscar num valor, ou solta com `null`.
   *
   * Está no contrato porque os DOIS corpos piscam e porque quem tira retrato
   * precisa parar o reflexo: o estúdio adianta segundos de animação num quadro
   * só, o piscar corre junto, e um card em cada tantos sai com a modelo de olho
   * fechado — defeito que não se reproduz olhando o jogo.
   */
  pinBlink(value: number | null): void;
  /**
   * "Esta pessoa acabou de dizer isto" — e a boca se mexe enquanto dura.
   *
   * OPCIONAL, e é a única coisa opcional deste contrato: o corpo procedural não
   * tem boca articulada por este caminho, e o dia em que tiver é o dia em que
   * ela deixa de ser opcional. Um corpo que não sabe falar simplesmente não
   * implementa, e quem chama não precisa saber qual corpo está em cena.
   *
   * Não é protocolo: o texto e o id já vieram na `ChatMessage` que o servidor
   * mandou para todo mundo, e a animação é feita em cada navegador a partir
   * deles. O id entra como SEMENTE — é o que faz duas abas do mesmo jogador
   * desenharem a mesma fala e a praça inteira não falar no mesmo compasso.
   */
  speak?(text: string, seed?: number): void;
  dispose(): void;
}

/**
 * De onde vem o corpo de um jogador.
 *
 * `v2` é o corpo do jogo desde a migração: montado com peças dos pacotes
 * Ultimate Modular, e é dele que sai o guarda-roupa de 83 peças da loja.
 *
 * `v1` é o procedural — corpo gerado por código, guarda-roupa lofteado das
 * estações dele, medido pelo portão de 176 combinações. Continua no código
 * atrás de `?body=v1` enquanto a migração é conferida: é rede de segurança, não
 * opção de produto, e sai junto com o v1.
 */
export type BodyKind = 'v1' | 'v2';
