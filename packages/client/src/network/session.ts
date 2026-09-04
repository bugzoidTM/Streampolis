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
  /**
   * Ir ao encontro de um amigo: entrar no SHARD dele, não numa cópia da cena.
   *
   * É uma intenção própria e não um `city` com um campo a mais porque a forma de
   * entrar é outra — `joinById`, que só encontra a sala que já existe. Um
   * `joinOrCreate` com filtro por sala levaria o jogador para "uma praça
   * central", que é exatamente o resultado errado: a praça certa, com a pessoa
   * certa dentro, é o ponto todo do botão.
   */
  | { kind: 'meet'; roomId: string; sceneId: SceneId }
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

  // `?meet=<shard>` abre direto na sala de alguém. Serve à captura de tela e ao
  // link de convite; o portão de amizade é da API, que é quem dá o shard.
  const meet = params.get('meet');
  if (meet) return { kind: 'meet', roomId: meet, sceneId: CITY_SCENES.has(scene) ? scene : 'central_plaza' };

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
    case 'meet':
      return meetAt(client, intent.roomId, intent.sceneId);
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

/**
 * Entra no shard do amigo — e, se ele não couber mais um, na cena dele.
 *
 * "Se houver vaga" é uma condição que só o servidor sabe responder, e ele
 * responde recusando o assento: uma praça cheia é uma sala TRANCADA pelo
 * matchmaker (é assim que o sharding acontece, ver `CityRoom`). Por isso o
 * caminho feliz é tentar e, se der errado, cair no matchmaking NORMAL da mesma
 * cena — sem inventar sala nenhuma e sem tocar em como todo mundo entra.
 *
 * O jogador não fica sem saber: quem compara o shard pedido com o shard obtido
 * é o `WorldView`, que avisa na tela quando os dois não batem.
 *
 * A recusa por CRACHÁ não entra nesse laço. Cair para a praça pública com um
 * token vencido esconderia "sua sessão acabou" atrás de "seu amigo saiu".
 */
async function meetAt(
  client: NetworkClient, roomId: string, sceneId: SceneId,
): Promise<AnyWorldConnection> {
  try {
    return await client.joinShard(roomId);
  } catch (err) {
    if (isAuthRefusal(err)) throw err;
    // Apartamento e live não têm "outra sala igual": a casa é uma só e a live é
    // daquele host. Falhar ali é falhar de verdade.
    if (!CITY_SCENES.has(sceneId)) throw err;
    console.warn(`[session] shard ${roomId} não aceitou; entrando em ${sceneId}:`, err);
    return client.joinCity(sceneId);
  }
}

/** O servidor recusou o token, não a sala. Mesma leitura do WorldView. */
function isAuthRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === 401
    || (typeof e.message === 'string' && /expired|token|signature|auth/i.test(e.message));
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
    case 'meet': return 'Indo até o seu amigo…';
    case 'offline': return 'Carregando a cena…';
  }
}
