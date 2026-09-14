import type { AnimState, AvatarConfig, PKPhase, SceneId } from '@streampolis/shared';

/**
 * Read-only view of the server's Colyseus schema.
 *
 * The browser decodes state by reflection, so it never imports the server's
 * schema classes — these interfaces are the shape contract instead. Keep them
 * in step with packages/game-server/src/rooms/schema.ts; a field renamed there
 * and not here is a silent `undefined`, not a compile error.
 */

export interface MapLike<V> {
  readonly size: number;
  get(key: string): V | undefined;
  forEach(cb: (value: V, key: string) => void): void;
}

export interface PlayerView {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
  moving: boolean;
  gifterLevel: number;
  agency: string;
  role: 'visitor' | 'owner' | 'host' | 'cohost' | 'spectator';
  avatar: AvatarConfig;
  /** Personagem da cidade, marcado pelo servidor (PRD §25). */
  npc?: boolean;
  /** Para quem está olhando (sessionId), quando a sala sabe; '' = ninguém em especial. */
  lookAt?: string;
  /** Um personagem guiando alguém: a sessão guiada e o destino (só desenho: minimapa). */
  guideTo?: string;
  guideX?: number;
  guideZ?: number;
}

export interface ListLike<V> extends Iterable<V> {
  readonly length: number;
}

export interface WorldStateView {
  sceneId: SceneId;
  shard: string;
  tick: number;
  /** O relógio do mundo (shared/clock.ts), escrito pela sala a cada segundo: minutos do dia e taxa. */
  clock?: number;
  clockRate?: number;
  /** O clima do mundo ('clear' | 'rain'), escolhido pela sala (shared/weather.ts). */
  weather?: string;
  players: MapLike<PlayerView>;
  /** City roster stays room-wide while positional players are filtered by AOI. */
  members?: MapLike<Pick<PlayerView, 'id' | 'name' | 'gifterLevel' | 'agency' | 'role' | 'avatar' | 'npc'>>;
}

/** Um móvel colocado pelo dono, como a SALA o publica (schema `PlacedItem`). */
export interface PlacedItemView {
  itemId: string;
  x: number;
  z: number;
  turn: number;
}

/**
 * O apartamento. A mobília chega por aqui — e não pela API — para uma coisa
 * só: COLIDIR. Quem desenha continua lendo `/homes/:id`, porque o modo de
 * construção mexe numa lista de rascunho que ainda não é verdade nenhuma; mas
 * a mesa de colisão do preditor tem de ser a mesma da sala, ou o jogador
 * atravessa o próprio sofá de um lado e bate nele do outro.
 */
export interface ApartmentStateView extends WorldStateView {
  ownerId: string;
  ownerName: string;
  decor: ListLike<PlacedItemView>;
}

export interface PKView {
  phase: PKPhase;
  hostA: string;
  hostB: string;
  nameA: string;
  nameB: string;
  scoreA: number;
  scoreB: number;
  endsAt: number;
  winnerId: string;
}

export interface LiveStateView extends WorldStateView {
  liveId: string;
  hostId: string;
  hostName: string;
  title: string;
  category: string;
  isPK: boolean;
  ended: boolean;
  startedAt: number;
  viewers: number;
  likes: number;
  coinsReceived: number;
  agency: string;
  pk: PKView;
}

/** Pose the renderer draws this frame — interpolated or predicted, never raw. */
export interface RenderPose {
  id: string;
  sessionId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
  moving: boolean;
  gifterLevel: number;
  avatar: AvatarConfig;
  isLocal: boolean;
  npc?: boolean;
  /** Alvo do Head Look vindo da sala (sessionId); vazio = a escolha local de sempre. */
  lookAt?: string;
  /** Personagem guiando esta sessão (ou outra): quem, e para onde. */
  guideTo?: string;
  guideX?: number;
  guideZ?: number;
}
