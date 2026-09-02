import type { AvatarConfig } from '@streampolis/shared';
import { Avatar, type AvatarOptions } from './Avatar.js';
import type { AvatarLike } from './AvatarLike.js';
import { AvatarV2, type V2Look } from './v2/AvatarV2.js';
import { loadClips, loadPart } from './v2/Wardrobe.js';

/**
 * O ÚNICO lugar onde um corpo de jogador nasce.
 *
 * Existe para a troca por um corpo comprado ser uma mudança neste arquivo, e
 * não uma caçada por `new Avatar(` espalhado pelo jogo.
 *
 * Hoje sabe fabricar os DOIS corpos — o procedural (`v1`) e o do pacote
 * (`v2`) —, e por padrão devolve o procedural mesmo quando o jogador pede
 * `'v2'`. Isso não é omissão, é o estado do produto: as 45 peças do
 * guarda-roupa são lofteadas das estações do corpo v1 e o portão de 176
 * combinações mede contra ele. Um jogador de corpo v2 anda com a roupa que o
 * autor do pacote pintou na textura, e nada da loja aparece nele.
 *
 * Então o v2 é uma PEÇA, não um botão: o servidor já valida `body` contra
 * posse de item como valida qualquer roupa, e o dia de vendê-lo é um dia de
 * catálogo — ativar `body_v2_01` em `shared/items.ts` e ligar o interruptor
 * abaixo. Não é um dia de refatoração, e essa é a diferença que este arquivo
 * e {@link AvatarLike} existem para garantir.
 */

/**
 * Qual corpo desenha o avatar.
 *
 * Desde a migração, o v2 é o padrão: o corpo é montado com peças de asset e o
 * guarda-roupa é o catálogo da loja. `?body=v1` reabre o corpo procedural,
 * que segue no código enquanto a migração é conferida — é rede de segurança,
 * não opção de produto, e sai junto com o v1.
 */
export function v2Enabled(): boolean {
  if (typeof location === 'undefined') return true;
  // O v2 é o corpo do jogo. `?body=v1` volta ao procedural enquanto ele ainda
  // existe no código — é a rede de segurança de uma migração, não uma opção de
  // produto.
  return new URLSearchParams(location.search).get('body') !== 'v1';
}

/**
 * As peças que um avatar veste quando o jogador ainda não escolheu.
 *
 * Um esqueleto sem peça nenhuma não é um avatar discreto: é nada em cena. O
 * padrão veste roupa de rua, que é o que uma cidade pede.
 */
export const DEFAULT_LOOK: V2Look = {
  head: 'm_casual_character_head',
  top: 'm_casual_character_top',
  bottom: 'm_casual_character_bottom',
  shoes: 'm_casual_character_shoes',
};

/**
 * A aparência do jogador, traduzida em peças.
 *
 * O protocolo continua com os mesmos quatro campos do v1 — trocar o formato do
 * `AvatarConfig` mexeria no token assinado, no schema da sala e no banco de uma
 * vez só. O que mudou é o SIGNIFICADO de um deles: `hair` passou a ser a CABEÇA
 * (rosto e cabelo vêm na mesma malha no pacote), e é por isso que o criador de
 * avatar mostra cabeças onde antes mostrava cortes.
 */
export function lookOf(config: AvatarConfig): V2Look {
  return {
    head: config.hair || DEFAULT_LOOK.head,
    top: config.top || DEFAULT_LOOK.top,
    bottom: config.bottom || DEFAULT_LOOK.bottom,
    shoes: config.shoes || DEFAULT_LOOK.shoes,
  };
}

export function createAvatar(config: AvatarConfig, options: AvatarOptions = {}): AvatarLike {
  if (v2Enabled()) return new AvatarV2(config, lookOf(config));
  return new Avatar(config, options);
}

/**
 * Busca o que os corpos deste cliente vão precisar, antes de o mundo aparecer.
 *
 * O corpo procedural não pede rede nenhuma e isto retorna na hora. O v2 pede 6
 * MB, e sem este passo eles seriam buscados DEPOIS da tela de carregamento
 * sair — a praça abriria vazia e as pessoas apareceriam uma a uma, que é
 * exatamente a impressão de travamento que a tela veio consertar.
 */
export async function preloadAvatarBodies(): Promise<void> {
  if (!v2Enabled()) return;
  await Promise.all([
    loadClips().catch(() => undefined),
    ...Object.values(DEFAULT_LOOK).map((id) => loadPart(id).catch(() => undefined)),
  ]);
}

/** Verdadeiro quando o corpo é o procedural — o único que sabe vestir roupa. */
export function isProcedural(avatar: AvatarLike): avatar is Avatar {
  return avatar instanceof Avatar;
}
