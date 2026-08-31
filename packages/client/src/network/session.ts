import type { SceneId } from '@streampolis/shared';
import { NetworkClient } from './NetworkClient.js';
import type { AnyWorldConnection } from './WorldConnection.js';

/**
 * O que o jogador quer fazer — e, portanto, em que sala ele entra.
 *
 * Antes o World decidia sozinho e chamava sempre `joinCity(sceneId)`, o que
 * tinha uma consequência silenciosa: `scene=live_room` virava uma CityRoom, a
 * CityRoom não aceita esse cenário, e o jogador acabava na praça olhando um
 * cenário de live que nunca carregou. Aqui a intenção é declarada, a conexão
 * certa é aberta, e o World só desenha a sala em que realmente está.
 */
export type WorldIntent =
  /** Sem servidor: mesma cena, física local, para revisão e para o offline. */
  | { kind: 'offline'; sceneId: SceneId }
  | { kind: 'city'; sceneId: SceneId }
  | { kind: 'apartment'; apartmentId: string }
  /** Abrir a PRÓPRIA live. O host sai do token; o cliente só escolhe o assunto. */
  | { kind: 'golive'; title: string; category: string; sceneId?: SceneId }
  /** Assistir à live de outra pessoa, pela sala que o feed listou. */
  | { kind: 'watch'; roomId: string };

export type IntentKind = WorldIntent['kind'];

/** Cenários que uma CityRoom aceita; os demais têm sala própria. */
const CITY_SCENES: ReadonlySet<SceneId> = new Set<SceneId>([
  'central_plaza', 'residential_lobby', 'stream_store', 'agency_tower',
]);

/** Cenários que podem hospedar uma transmissão (PRD §10). */
const LIVE_SCENES: ReadonlySet<SceneId> = new Set<SceneId>([
  'live_room', 'apartment', 'pk_arena',
]);

export function isLiveIntent(kind: IntentKind): boolean {
  return kind === 'golive' || kind === 'watch';
}

/**
 * Lê a intenção da URL.
 *
 * Sem token nada disso vale: o mundo roda offline e a única pergunta é qual
 * cena desenhar. Com token, `watch` e `golive` ganham de `scene`, porque entrar
 * numa live é mais específico do que escolher um cenário.
 */
export function intentFromQuery(params: URLSearchParams, hasToken: boolean): WorldIntent {
  const scene = (params.get('scene') as SceneId | null) ?? 'central_plaza';

  if (!hasToken) return { kind: 'offline', sceneId: scene };

  const watch = params.get('watch');
  if (watch) return { kind: 'watch', roomId: watch };

  const apartment = params.get('apartment');
  if (apartment) return { kind: 'apartment', apartmentId: apartment };

  const goLive = params.get('golive');
  if (goLive || LIVE_SCENES.has(scene)) {
    return {
      kind: 'golive',
      title: params.get('title') ?? 'Live',
      category: params.get('category') ?? 'geral',
      // `scene=live_room` sem mais nada é um pedido de abrir a própria live
      // ali: é a única leitura em que o cenário de live faz sentido sozinho.
      sceneId: LIVE_SCENES.has(scene) ? scene : 'live_room',
    };
  }

  if (!CITY_SCENES.has(scene)) {
    console.warn(`[session] "${scene}" não é cenário de cidade; entrando na praça.`);
    return { kind: 'city', sceneId: 'central_plaza' };
  }
  return { kind: 'city', sceneId: scene };
}

/** Abre a conexão que a intenção pede. Quem constrói a sala é o NetworkClient. */
export async function openWorld(
  client: NetworkClient, intent: WorldIntent,
): Promise<AnyWorldConnection> {
  switch (intent.kind) {
    case 'city':
      return client.joinCity(intent.sceneId);
    case 'apartment':
      return client.joinApartment(await resolveApartment(client, intent.apartmentId));
    case 'golive':
      return client.goLive({
        title: intent.title,
        category: intent.category,
        sceneId: intent.sceneId ?? 'live_room',
      });
    case 'watch':
      return client.watchLive(intent.roomId);
    case 'offline':
      throw new Error('intenção offline não abre conexão');
  }
}

/** `?apartment=me` pergunta à API qual é a casa do jogador. */
async function resolveApartment(client: NetworkClient, id: string): Promise<string> {
  if (id !== 'me') return id;
  const home = await client.myHome();
  if (!home) throw new Error('não foi possível descobrir seu apartamento');
  return home;
}

/** Texto curto para a barra de status enquanto conecta ou quando falha. */
export function describeIntent(intent: WorldIntent): string {
  switch (intent.kind) {
    case 'city': return 'Entrando na cidade…';
    case 'apartment': return 'Abrindo seu apartamento…';
    case 'golive': return 'Abrindo sua live…';
    case 'watch': return 'Entrando na live…';
    case 'offline': return 'Carregando a cena…';
  }
}
