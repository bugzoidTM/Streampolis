import { Client, type Room } from 'colyseus.js';
import { config } from './config.js';
import { log, warn } from './log.js';
import { MSG, TICK_MS, type ChatMessage, type MoveIntent, type SceneId } from './shared.js';
import { Walker, type Point } from './walker.js';

/**
 * O corpo do personagem na sala: um cliente Colyseus igual ao do navegador.
 *
 * Igual DE PROPÓSITO. O game server não tem caminho especial para NPC — ele
 * entra pela matchmaking, autentica com um token da API, é limitado pelo
 * mesmo ChatGuard, movido pela mesma MovementController e visto pela mesma
 * área de interesse. Se um dia o NPC "trapacear", é bug do servidor que um
 * jogador também exploraria; se ficar preso, um jogador ficaria também.
 *
 * O que sai daqui para a cabeça (`brain.ts`) são acontecimentos: alguém
 * falou, alguém chegou perto, alguém saiu. O que entra são duas ordens: fale,
 * vá até ali (ou fique olhando para fulano).
 */

export interface Nearby {
  sessionId: string;
  userId: string;
  name: string;
  x: number;
  z: number;
  npc: boolean;
}

interface PlayerLike {
  id: string;
  name: string;
  x: number;
  z: number;
  npc?: boolean;
}

interface StateLike {
  sceneId: SceneId;
  shard: string;
  players: {
    get(key: string): PlayerLike | undefined;
    forEach(cb: (value: PlayerLike, key: string) => void): void;
  };
}

export interface WorldEvents {
  chat(msg: ChatMessage): void;
  /** Alguém entrou na área de interesse (a ~24 m) — não necessariamente na conversa. */
  appeared(p: Nearby): void;
  gone(p: Nearby): void;
  notice(code: string, message: string): void;
  disconnected(code: number): void;
}

/**
 * Ver `config.gamePublicPrefix`: no modo distribuído a reserva de assento
 * aponta para o endereço PÚBLICO da sala (`streampolis.nutef.com/ws/1`); por
 * dentro da rede o gateway atende o mesmo caminho sem o prefixo. Sem prefixo
 * configurado, a URL passa como veio.
 */
export function internalUrlBuilder(
  publicPrefix = config.gamePublicPrefix,
  internalHost = config.gameInternalHost,
): (url: URL) => string {
  if (!publicPrefix || !internalHost) return (url) => url.toString();
  const prefix = publicPrefix.replace(/\/+$/, '');
  const [pubHost, ...pubPath] = prefix.split('/');
  const pubPrefixPath = '/' + pubPath.join('/');
  return (url: URL) => {
    if (url.host === pubHost) {
      url.host = internalHost;
      if (pubPath.length && url.pathname.startsWith(pubPrefixPath)) {
        url.pathname = url.pathname.slice(pubPrefixPath.length) || '/';
      }
    }
    return url.toString();
  };
}

/** Quantas intenções por lote e de quanto em quanto: 3 por 125 ms = 24/s, o tique do servidor. */
const BATCH_STEPS = 3;
const BATCH_MS = TICK_MS * BATCH_STEPS;

export class World {
  private client: Client;
  private room: Room<StateLike> | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly walker: Walker;
  private nearby = new Map<string, Nearby>();
  private lastSaidAt = 0;

  constructor(private readonly sceneId: SceneId, private readonly events: WorldEvents) {
    this.client = new Client(config.gameServerUrl, { urlBuilder: internalUrlBuilder() });
    this.walker = new Walker(sceneId);
  }

  get connected(): boolean {
    return this.room !== null;
  }

  get roomId(): string | null {
    return this.room?.roomId ?? null;
  }

  get sessionId(): string | null {
    return this.room?.sessionId ?? null;
  }

  /** Onde a SALA diz que o corpo está. Nulo até o primeiro estado chegar. */
  get position(): Point | null {
    const me = this.room?.state?.players?.get(this.room.sessionId);
    return me ? { x: me.x, z: me.z } : null;
  }

  /** Quem está ao alcance da vista, com distância até o personagem. */
  people(): Array<Nearby & { distance: number }> {
    const me = this.position;
    const out: Array<Nearby & { distance: number }> = [];
    if (!me) return out;
    const state = this.room?.state;
    state?.players?.forEach((p, sessionId) => {
      if (sessionId === this.room?.sessionId) return;
      out.push({
        sessionId, userId: p.id, name: p.name, x: p.x, z: p.z, npc: p.npc === true,
        distance: Math.hypot(p.x - me.x, p.z - me.z),
      });
    });
    return out.sort((a, b) => a.distance - b.distance);
  }

  async join(token: string): Promise<void> {
    const room = await this.client.joinOrCreate<StateLike>('city', { token, sceneId: this.sceneId });
    this.room = room;
    this.nearby.clear();
    log('world', 'entrou na sala', { room: room.roomId, session: room.sessionId });

    room.onMessage(MSG.chatMessage, (msg: ChatMessage) => this.events.chat(msg));
    room.onMessage(MSG.notice, (n: { code?: string; text?: string }) => {
      this.events.notice(n?.code ?? '', n?.text ?? '');
    });
    room.onMessage(MSG.correction, () => {});
    // Mensagens que o servidor manda a todo mundo e não interessam aqui.
    for (const m of [MSG.giftEvent, MSG.likeTotals, MSG.follow, MSG.gigUpdate, 'stageInvite', 'pkState']) {
      room.onMessage(m, () => {});
    }
    room.onMessage('*', () => {});

    room.onLeave((code) => {
      warn('world', 'saiu da sala', { code });
      this.stopLoop();
      this.room = null;
      this.nearby.clear();
      this.events.disconnected(code);
    });
    room.onError((code, message) => warn('world', 'erro da sala', { code, message }));

    // Quem apareceu e quem sumiu, por DIFERENÇA a cada patch — o mesmo
    // caminho do navegador (`WorldConnection`). A área de interesse da cidade
    // põe e tira gente do mapa conforme a distância, então "apareceu" é
    // "entrou no alcance da vista", não "entrou na sala".
    room.onStateChange((state) => {
      const seen = new Set<string>();
      state.players?.forEach((p, sessionId) => {
        if (sessionId === room.sessionId) return;
        seen.add(sessionId);
        const known = this.nearby.get(sessionId);
        if (known) {
          known.x = p.x;
          known.z = p.z;
          known.name = p.name;
          return;
        }
        const entry: Nearby = { sessionId, userId: p.id, name: p.name, x: p.x, z: p.z, npc: p.npc === true };
        this.nearby.set(sessionId, entry);
        this.events.appeared(entry);
      });
      for (const [sessionId, entry] of [...this.nearby]) {
        if (seen.has(sessionId)) continue;
        this.nearby.delete(sessionId);
        this.events.gone(entry);
      }
    });

    this.startLoop();
  }

  async leave(): Promise<void> {
    this.stopLoop();
    const room = this.room;
    this.room = null;
    if (room) await room.leave(true).catch(() => {});
  }

  /**
   * Fala. O servidor aplica o ChatGuard (tamanho, taxa, filtro) e o
   * personagem obedece ao mesmo limite de 5 mensagens por 5 s de qualquer um —
   * com folga extra aqui, porque um personagem que fala em rajada lê como bot.
   */
  say(text: string): boolean {
    if (!this.room) return false;
    const now = Date.now();
    if (now - this.lastSaidAt < 1_500) return false;
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return false;
    this.room.send(MSG.chat, { text: clean });
    this.lastSaidAt = now;
    return true;
  }

  /** Vira-se para alguém e para de andar (a conversa acontece parado). */
  faceTo(target: Point): void {
    const me = this.position;
    if (me) this.walker.face(target, me);
  }

  private startLoop(): void {
    this.stopLoop();
    this.timer = setInterval(() => this.pump(), BATCH_MS);
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Um lote de intenções por tique de lote. Sem destino, nada é enviado. */
  private pump(): void {
    const room = this.room;
    const me = this.position;
    if (!room || !me) return;
    const intents: MoveIntent[] = this.walker.intents(me, BATCH_STEPS);
    for (const intent of intents) room.send(MSG.move, intent);
  }
}
