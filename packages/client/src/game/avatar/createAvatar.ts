import type { AvatarConfig } from '@streampolis/shared';
import { Avatar, type AvatarOptions } from './Avatar.js';
import type { AvatarLike } from './AvatarLike.js';
import { AvatarV2 } from './v2/AvatarV2.js';
import { loadKit } from './v2/Kit.js';

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
 * Interruptor de campo do corpo v2.
 *
 * `?body=v2` na URL trata este cliente como se o item já estivesse liberado, e
 * é assim que se OLHA para o v2 dentro do jogo de verdade — praça, câmera,
 * multiplayer, placa de nome — em vez de no laboratório. Fora disso o corpo
 * v2 não entra em jogo nem para quem forjar um token: esta é a rede de
 * segurança do lado do cliente, e a do lado do servidor é a validação de posse
 * em `AvatarService`.
 */
export function v2Enabled(): boolean {
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('body') === 'v2';
}

export function createAvatar(config: AvatarConfig, options: AvatarOptions = {}): AvatarLike {
  if (v2Enabled()) return new AvatarV2(config);
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
  await loadKit({ id: 'female', hairstyle: 'hair_parted' }).catch(() => undefined);
  await loadKit({ id: 'male', hairstyle: 'hair_parted' }).catch(() => undefined);
}

/** Verdadeiro quando o corpo é o procedural — o único que sabe vestir roupa. */
export function isProcedural(avatar: AvatarLike): avatar is Avatar {
  return avatar instanceof Avatar;
}
