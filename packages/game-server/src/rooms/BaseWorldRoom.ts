import { Room, ServerError, type Client } from '@colyseus/core';
import {
  MSG,
  PLAY_AREA,
  SCENE_AREA,
  SCENE_COLLIDERS,
  penetrates,
  TICK_MS,
  type AnimState,
  type ChatMessage,
  type Collider,
  type MoveCorrection,
  type PresenceKind,
  type SceneId,
  type SystemNotice,
} from '../shared.js';
import { AuthError, defaultAuthProvider, type AuthIdentity, type AuthProvider } from '../auth/AuthProvider.js';
import { ChatGuard } from '../social/ChatGuard.js';
import { MovementController } from '../sim/Movement.js';
import { presence } from '../world/Presence.js';
import { spawnFor } from '../world/Spawns.js';
import { PlayerState, WorldState, type RoomRole } from './schema.js';

/** Emotes a client may trigger. Locomotion and battle states are server-owned. */
const EMOTABLE: ReadonlySet<AnimState> = new Set<AnimState>([
  'idle', 'sit', 'wave', 'clap', 'dance', 'celebrate',
]);

const EMOTE_COOLDOWN_MS = 900;

/** Options a room is created with. Subclasses widen this, never narrow it. */
export interface RoomCreateOptions {
  sceneId?: SceneId;
  capacity?: number;
  [key: string]: unknown;
}

export interface WorldJoinOptions {
  token?: string;
  sceneId?: SceneId;
}

interface Session {
  identity: AuthIdentity;
  movement: MovementController;
  lastEmoteAt: number;
}

/**
 * Everything a walkable room does: authenticate, spawn, move, chat, emote.
 *
 * The tick loop here is the only writer of position in the whole server. A
 * client message never mutates PlayerState directly — it enqueues an intent,
 * and MovementController decides what, if anything, becomes true (SPECs §21).
 */
export abstract class BaseWorldRoom<S extends WorldState = WorldState> extends Room<S> {
  /** Not readonly: rooms that host several scenes set it from onCreate options. */
  abstract sceneId: SceneId;

  protected readonly auth: AuthProvider = defaultAuthProvider();
  protected readonly chat = new ChatGuard();
  protected readonly sessions = new Map<string, Session>();
  /** Monotonic, so two players joining on the same ms get different spawns. */
  private joinCounter = 0;

  /** Concrete rooms build their own state subclass here. */
  protected abstract createState(): S;

  override onCreate(options: RoomCreateOptions = {}): void {
    const state = this.createState();
    state.sceneId = this.sceneId;
    state.shard = this.roomId;
    this.setState(state);

    if (typeof options.capacity === 'number' && options.capacity > 0) {
      this.maxClients = options.capacity;
    }

    // 24 Hz simulation, 20 Hz patches (SPECs §18): rendering is decoupled, so
    // patching faster than the tick only burns bandwidth.
    this.setSimulationInterval(() => this.tick(), TICK_MS);
    this.patchRate = 50;

    this.registerWorldMessages();
    this.onRoomCreated(options);
  }

  /** Hook for subclasses; runs after state, tick loop and handlers are up. */
  protected onRoomCreated(_options: RoomCreateOptions): void {}

  /**
   * Onde não se pisa nesta sala.
   *
   * O default é a planta da cena e nada mais. O apartamento soma a mobília que
   * o DONO colocou: ela é chão ocupado igual à que veio com a planta, e sem
   * isto o servidor resolvia o movimento num cômodo vazio enquanto o jogador
   * via um cômodo cheio.
   */
  protected colliders(): readonly Collider[] {
    return SCENE_COLLIDERS[this.sceneId];
  }

  /**
   * Reapresenta a mesa de colisão a quem já está dentro, e desencalha quem a
   * mobília nova pegou embaixo.
   *
   * Chamado quando a sala MUDA de mobília no meio da sessão. Andar para dentro
   * de um móvel não é mais possível — o passo que terminaria dentro de um
   * bloqueador não acontece (ver `resolveCollision`) —, mas redecorar é o
   * caminho que sobra: o sofá aparece em cima de quem já estava ali. E de
   * dentro não se sai andando; entre dois móveis encostados as saídas do
   * resolvedor se anulam e todas as direções voltam ao mesmo ponto.
   *
   * Então quem desencalha é a SALA, com o ponto de chegada — que a planta prova
   * estar livre (`game-server/test/world.test.ts`). É teleporte, sim, e é o
   * único: o preço de um corpo aparecer dois metros ao lado é muito menor que o
   * de um jogador preso dentro do próprio sofá até recarregar a página.
   */
  protected refreshColliders(): void {
    const colliders = this.colliders();
    const area = SCENE_AREA[this.sceneId] ?? null;
    for (const session of this.sessions.values()) {
      session.movement.setArea(PLAY_AREA[this.sceneId], colliders, area);
      if (penetrates(session.movement.current, colliders)) {
        session.movement.place(spawnFor(this.sceneId, this.joinCounter++));
      }
    }
  }

  override async onAuth(_client: Client, options: WorldJoinOptions): Promise<AuthIdentity> {
    try {
      return await this.auth.authenticate(options?.token ?? '');
    } catch (err) {
      const code = err instanceof AuthError ? err.code : 'auth_failed';
      // 401 travels to the browser as a Colyseus error code; the client turns
      // it into "sua sessão expirou" instead of a generic disconnect.
      throw new ServerError(401, code);
    }
  }

  override onJoin(client: Client, options: WorldJoinOptions = {}, auth?: AuthIdentity): void {
    const identity = auth ?? (client.auth as AuthIdentity);
    if (!identity) throw new ServerError(401, 'no_identity');

    // One session per user: a second tab must not produce a ghost twin that
    // still walks around after the first is closed.
    const duplicate = [...this.sessions.entries()].find(([, s]) => s.identity.userId === identity.userId);
    if (duplicate) {
      const [oldSessionId] = duplicate;
      this.clients.find((c) => c.sessionId === oldSessionId)?.leave(4001);
      this.removeSession(oldSessionId);
    }

    const spawn = spawnFor(this.sceneId, this.joinCounter++);
    this.sessions.set(client.sessionId, {
      identity,
      movement: new MovementController(
        spawn,
        PLAY_AREA[this.sceneId],
        Date.now,
        this.colliders(),
        SCENE_AREA[this.sceneId] ?? null,
      ),
      lastEmoteAt: 0,
    });

    // A partir daqui o jogador tem endereço: cena E shard. É o que permite a
    // outra pessoa chegar até ele em vez de chegar até "a praça" (SPECs §17).
    this.trackPresence(identity);

    // Spectators get a session (chat, rate limits, blocks) but no body: a live
    // with 100 viewers must not synchronise 100 avatars (SPECs §10).
    if (!this.spawnsAvatar(identity)) {
      this.onPlayerJoined(client, identity, null);
      return;
    }

    const player = this.spawnPlayer(client, identity);
    this.onPlayerJoined(client, identity, player);
  }

  /**
   * Gives a connected client a body. Separate from onJoin because a live room
   * promotes a spectator to the stage mid-session, and that must go through
   * exactly the same construction — including the avatar rule below.
   */
  protected spawnPlayer(client: Client, identity: AuthIdentity): PlayerState {
    const session = this.sessions.get(client.sessionId);
    const spawn = session ? { ...session.movement.current } : spawnFor(this.sceneId, this.joinCounter++);

    const player = new PlayerState();
    player.id = identity.userId;
    player.name = identity.displayName;
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    player.yaw = spawn.yaw;
    player.gifterLevel = identity.gifterLevel;
    player.agency = identity.agency;
    player.role = this.roleFor(identity);
    // Appearance comes from the token the API signed — NEVER from join
    // options. Trusting the browser here is how a free tee becomes a
    // 5.000-Coin item without anyone paying (SPECs §68 regra 6).
    player.avatar.apply(identity.avatar);

    this.state.players.set(client.sessionId, player);
    return player;
  }

  /** Removes the body but keeps the session: the client is still connected. */
  protected despawnPlayer(client: Client): void {
    this.state.players.delete(client.sessionId);
  }

  /** False for clients that watch instead of inhabiting the room. */
  protected spawnsAvatar(_identity: AuthIdentity): boolean {
    return true;
  }

  override onLeave(client: Client, _consented?: boolean): void {
    const session = this.sessions.get(client.sessionId);
    this.removeSession(client.sessionId);
    if (!session) return;
    // Dentro do `if` de propósito. A segunda aba do mesmo usuário derruba a
    // primeira em onJoin, e o onLeave dela chega DEPOIS — se a saída não
    // dependesse de a sessão ainda existir, a aba velha apagaria a presença da
    // aba nova, na mesma sala, e o jogador sumiria estando dentro.
    presence().leave(session.identity.userId, this.roomId);
    this.onPlayerLeft(client, session.identity);
  }

  /** A sala acabou: ninguém que estava nela continua em lugar nenhum. */
  override onDispose(): void {
    presence().dropRoom(this.roomId);
  }

  /**
   * Como esta sala aparece no diretório. O default é "está no mundo"; a live
   * distingue palco de plateia.
   */
  protected presenceKind(_identity: AuthIdentity): PresenceKind {
    return 'in_world';
  }

  private trackPresence(identity: AuthIdentity): void {
    presence().enter({
      userId: identity.userId,
      sceneId: this.sceneId,
      roomId: this.roomId,
      kind: this.presenceKind(identity),
    });
  }

  /**
   * Reanuncia todo mundo. Serve para mudanças que não são entrada nem saída —
   * subir ao palco, começar um PK — em que o lugar é o mesmo e o que mudou é o
   * que a pessoa está fazendo ali. `enter` é idempotente, então chamar isto de
   * graça não custa publicação nenhuma.
   */
  protected refreshPresence(): void {
    for (const session of this.sessions.values()) this.trackPresence(session.identity);
  }

  protected onPlayerJoined(_client: Client, _identity: AuthIdentity, _player: PlayerState | null): void {}
  protected onPlayerLeft(_client: Client, _identity: AuthIdentity): void {}

  /** Default role in a public room; apartments and lives override it. */
  protected roleFor(_identity: AuthIdentity): RoomRole {
    return 'visitor';
  }

  protected identityOf(client: Client): AuthIdentity | undefined {
    return this.sessions.get(client.sessionId)?.identity;
  }

  protected notify(client: Client, code: string, text: string): void {
    const notice: SystemNotice = { code, text };
    client.send(MSG.notice, notice);
  }

  private removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) this.chat.forget(session.identity.userId);
    this.sessions.delete(sessionId);
    this.state.players.delete(sessionId);
  }

  private registerWorldMessages(): void {
    this.onMessage(MSG.move, (client, message) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      const reason = session.movement.enqueue(message);
      // Silence is deliberate for stale_seq: duplicates are normal on a lossy
      // link, and answering every one of them doubles the uplink of a flooder.
      if (reason === 'flood') this.notify(client, 'move_flood', 'Movimento ignorado: excesso de comandos.');
    });

    this.onMessage(MSG.chat, (client, message: { text?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (!session) return;
      const verdict = this.chat.check(session.identity.userId, message?.text);
      if (!verdict.ok) {
        this.notify(client, `chat_${verdict.reason}`, verdict.message);
        return;
      }
      this.publishChat({
        id: `${this.roomId}:${Date.now()}:${client.sessionId}`,
        senderId: session.identity.userId,
        senderName: session.identity.displayName,
        text: verdict.text,
        gifterLevel: session.identity.gifterLevel,
        timestamp: Date.now(),
      });
    });

    this.onMessage(MSG.emote, (client, message: { anim?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (!session || !player) return;
      const anim = message?.anim;
      if (typeof anim !== 'string' || !EMOTABLE.has(anim as AnimState)) return;

      const now = Date.now();
      if (now - session.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
      session.lastEmoteAt = now;
      // Walking cancels an emote on the next tick anyway; refusing it while
      // moving avoids a frame of a dancing avatar sliding across the plaza.
      if (player.moving) return;
      player.anim = anim as AnimState;
    });

    this.onMessage(MSG.mute, (client, message: { userId?: unknown; ms?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (!session || !session.identity.permissions.includes('moderate')) return;
      if (typeof message?.userId !== 'string') return;
      const ms = typeof message.ms === 'number' && message.ms > 0 ? Math.min(message.ms, 86_400_000) : 600_000;
      this.chat.mute(message.userId, ms);
    });

    this.onMessage(MSG.block, (client, message: { userId?: unknown; on?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (!session || typeof message?.userId !== 'string') return;
      if (message.on === false) this.chat.unblock(session.identity.userId, message.userId);
      else this.chat.block(session.identity.userId, message.userId);
    });

    /**
     * Trocar de roupa SEM sair da sala.
     *
     * A aparência entra na sala pelo token assinado, e antes disto só entrava
     * uma vez, no join: quem comprava um moletom continuava de camiseta para
     * todo mundo até reconectar. O criador de avatar tornou isso gritante —
     * salvar o visual não mudava nada no mundo.
     *
     * O cliente não manda a roupa: manda o TOKEN NOVO, que a API assinou
     * depois de validar cada peça contra o inventário. Aqui ele é verificado
     * como qualquer outro e só vale para o próprio dono — `sub` tem de ser o
     * mesmo usuário da sessão, senão é gente vestindo o avatar dos outros, que
     * é literalmente um bug que este projeto já teve.
     */
    this.onMessage(MSG.restyle, (client, message: { token?: unknown }) => {
      const session = this.sessions.get(client.sessionId);
      if (!session || typeof message?.token !== 'string') return;
      void this.auth.authenticate(message.token)
        .then((identity) => {
          if (identity.userId !== session.identity.userId) {
            this.notify(client, 'restyle_denied', 'Este token não é seu.');
            return;
          }
          const player = this.state.players.get(client.sessionId);
          if (!player) return;
          player.avatar.apply(identity.avatar);
          player.gifterLevel = identity.gifterLevel;
          // A sessão guarda a identidade para o resto da sala (presente, PK,
          // live). Deixá-la velha faria o próximo evento reescrever a roupa
          // antiga por cima da nova.
          session.identity = identity;
        })
        .catch(() => this.notify(client, 'restyle_failed', 'Não deu para aplicar o visual.'));
    });
  }

  /** Per-recipient delivery, so a block list actually blocks (SPECs §31). */
  protected publishChat(msg: ChatMessage): void {
    for (const client of this.clients) {
      const viewer = this.sessions.get(client.sessionId);
      if (viewer && this.chat.blocksSender(viewer.identity.userId, msg.senderId)) continue;
      client.send(MSG.chatMessage, msg);
    }
  }

  protected systemChat(text: string): void {
    this.publishChat({
      id: `${this.roomId}:sys:${Date.now()}`,
      senderId: '',
      senderName: 'Streampolis',
      text,
      gifterLevel: 0,
      timestamp: Date.now(),
      system: true,
    });
  }

  private tick(): void {
    this.state.tick = (this.state.tick + 1) >>> 0;

    for (const client of this.clients) {
      const session = this.sessions.get(client.sessionId);
      const player = this.state.players.get(client.sessionId);
      if (!session || !player) continue;

      const outcome = session.movement.step();
      player.x = outcome.pose.x;
      player.y = outcome.pose.y;
      player.z = outcome.pose.z;
      player.yaw = outcome.pose.yaw;
      player.moving = outcome.pose.moving;
      if (outcome.pose.moving) player.anim = 'walk';
      else if (player.anim === 'walk' || player.anim === 'run') player.anim = 'idle';

      // Only send a correction when the server actually overrode the client.
      // A per-tick echo would be a second full position stream on the downlink.
      if (outcome.corrected) {
        const correction: MoveCorrection = {
          seq: outcome.lastSeq,
          x: outcome.pose.x,
          y: outcome.pose.y,
          z: outcome.pose.z,
          yaw: outcome.pose.yaw,
          corrected: true,
        };
        client.send(MSG.correction, correction);
      }
    }

    this.onTick();
  }

  /** Subclass simulation, run after movement has been resolved. */
  protected onTick(): void {}
}
