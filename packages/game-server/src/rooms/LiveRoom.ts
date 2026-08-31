import { ServerError, type Client } from '@colyseus/core';
import {
  GIFT_BY_ID,
  MSG,
  SCENES,
  type FollowEvent,
  type GiftEvent,
  type LikeTotals,
  type PKResult,
  type SceneId,
} from '../shared.js';
import { AuthError, type AuthIdentity } from '../auth/AuthProvider.js';
import { config } from '../config.js';
import { defaultEconomyGateway, MAX_GIFT_QUANTITY, type EconomyGateway } from '../economy/EconomyGateway.js';
import { defaultApiGateway, type ApiGateway } from '../api/ApiGateway.js';
import { LikeAggregator } from '../social/LikeAggregator.js';
import { PKEngine, type PKEvent } from '../pk/PKEngine.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { LiveState, type RoomRole } from './schema.js';

/**
 * What the browser may say when opening a live: what the broadcast is about.
 *
 * NOT who the host is. The host is read from the token — a client that could
 * name the host could open a live in someone else's name, and `watchLive`
 * joining an existing room by id means it can never create one either.
 */
export interface LiveOptions extends RoomCreateOptions {
  token?: string;
  title?: string;
  category?: string;
  sceneId?: SceneId;
}

interface LiveJoinOptions {
  token?: string;
}

/** How long a stage invite stays open before it has to be sent again. */
const INVITE_TTL_MS = 60_000;

const LIVE_SCENES: ReadonlySet<SceneId> = new Set<SceneId>(['live_room', 'apartment', 'pk_arena']);
const LIKE_FLUSH_MS = 1_000;
const IDEMPOTENCY_KEY_MAX = 96;

/**
 * A broadcast (SPECs §10, §17, §30, §33).
 *
 * Everything expensive is deliberately absent: spectators have no body, no
 * position and no movement controller. What the room does own is the ORDER of
 * events — a gift is charged first and broadcast second, so no animation ever
 * plays for coins that did not actually leave a wallet (SPECs §68 regra 4/6).
 */
export class LiveRoom extends BaseWorldRoom<LiveState> {
  sceneId: SceneId = 'live_room';

  private readonly economy: EconomyGateway = defaultEconomyGateway();
  private readonly api: ApiGateway = defaultApiGateway();
  private readonly likes = new LikeAggregator();
  private readonly pk = new PKEngine();
  /** Stage seats by userId, so a rejoin restores the seat, not the sessionId. */
  private hostId = '';
  private cohostId = '';
  /** Pending stage offer. One at a time: two open invites is a race for a seat. */
  private invite: { userId: string; expiresAt: number } | null = null;
  /**
   * Id da sessão no banco, devolvido pela API ao abrir a live.
   *
   * Não é o mesmo que `state.liveId`: aquele é a chave externa que o servidor
   * gera, este é a linha de stream_sessions. A economia referencia a LINHA —
   * mandar a chave externa faz a API recusar o presente por payload inválido, e
   * o jogador vê "presente recusado" sem entender por quê.
   */
  private apiLiveId: string | null = null;
  private pkStartedAt = 0;
  private peakViewers = 0;
  private readonly uniqueViewers = new Set<string>();
  private lastLikeFlush = 0;
  private giftSeq = 0;

  protected createState(): LiveState {
    return new LiveState();
  }

  /**
   * The live is created by its host, and the host is whoever the token says.
   *
   * onCreate runs before any onAuth, so the room verifies the creator's token
   * itself. Without this the room would be taking the host's identity from
   * whatever JSON the browser sent.
   */
  override async onCreate(options: LiveOptions = {}): Promise<void> {
    let host: AuthIdentity;
    try {
      host = await this.auth.authenticate(options.token ?? '');
    } catch (err) {
      throw new ServerError(401, err instanceof AuthError ? err.code : 'auth_failed');
    }

    if (options.sceneId && LIVE_SCENES.has(options.sceneId)) this.sceneId = options.sceneId;
    this.hostId = host.userId;

    super.onCreate({ ...options, capacity: config.liveCapacity });

    // The id is the server's, not the client's: it is what the API keys the
    // stream session on, and a client-chosen id could collide with another
    // host's session on purpose.
    this.state.liveId = `live_${this.roomId}`;
    this.state.hostId = this.hostId;
    this.state.hostName = host.displayName;
    this.state.title = (options.title ?? '').trim().slice(0, 80) || 'Live';
    this.state.category = (options.category ?? 'geral').slice(0, 32);
    this.state.agency = host.agency;
    this.state.startedAt = Date.now();

    this.registerLiveMessages();
    this.publishListing();

    // The API owns the record of the session; a failure to register does not
    // stop the broadcast, it just means the feed row is missing until close.
    void this.api
      .openLive({
        externalId: this.state.liveId,
        hostId: this.hostId,
        title: this.state.title,
        category: this.state.category,
        roomId: this.roomId,
      })
      .then((session) => { this.apiLiveId = session?.liveId ?? null; });
  }

  /** Only the stage walks. Everyone else is an audience member (SPECs §10). */
  protected override spawnsAvatar(identity: AuthIdentity): boolean {
    return identity.userId === this.hostId || identity.userId === this.cohostId;
  }

  protected override roleFor(identity: AuthIdentity): RoomRole {
    if (identity.userId === this.hostId) return 'host';
    if (identity.userId === this.cohostId) return 'cohost';
    return 'spectator';
  }

  override onJoin(client: Client, options: LiveJoinOptions = {}, auth?: AuthIdentity): void {
    const identity = auth ?? (client.auth as AuthIdentity);
    if (this.state.ended) throw new ServerError(410, 'live_ended');

    // Everyone arrives as audience. The stage is granted by the host through an
    // invite the guest accepts — never claimed by asking for it on join.
    super.onJoin(client, options, auth);
    if (identity) this.uniqueViewers.add(identity.userId);
    this.refreshViewers();
  }

  protected override onPlayerLeft(_client: Client, identity: AuthIdentity): void {
    if (identity.userId === this.cohostId) {
      this.cohostId = '';
      if (this.pk.active) this.applyPKEvents(this.pk.abort('host_left'));
    }
    if (identity.userId === this.hostId) {
      // The host leaving ends the broadcast: an unhosted live would keep
      // accepting gifts with nobody to receive them.
      if (this.pk.active) this.applyPKEvents(this.pk.abort('host_left'));
      this.endLive('host_left');
    }
    this.refreshViewers();
  }

  private refreshViewers(): void {
    const stage = this.state.players.size;
    this.state.viewers = Math.max(0, this.clients.length - stage);
    this.peakViewers = Math.max(this.peakViewers, this.state.viewers);
    this.publishListing();
  }

  /** Metadata is what the live feed lists (PRD §11, SPECs §50). */
  private publishListing(): void {
    this.setMetadata({
      liveId: this.state.liveId,
      hostId: this.state.hostId,
      hostName: this.state.hostName,
      title: this.state.title,
      category: this.state.category,
      sceneId: this.sceneId,
      realViewers: this.state.viewers,
      isPK: this.state.isPK,
      agency: this.state.agency,
      startedAt: this.state.startedAt,
      ended: this.state.ended,
    });
  }

  private registerLiveMessages(): void {
    this.onMessage(MSG.gift, (client, message) => {
      void this.handleGift(client, message);
    });

    this.onMessage(MSG.like, (client, message: { count?: unknown }) => {
      const session = this.identityOf(client);
      if (!session) return;
      const raw = typeof message?.count === 'number' ? message.count : 1;
      this.likes.add(session.userId, Math.trunc(raw));
    });

    this.onMessage(MSG.startPK, (client, message: { opponentId?: unknown; opponentName?: unknown }) => {
      const identity = this.identityOf(client);
      if (!identity || identity.userId !== this.hostId) {
        if (identity) this.notify(client, 'pk_not_host', 'Só o host pode iniciar um PK.');
        return;
      }
      if (this.pk.active) {
        this.notify(client, 'pk_running', 'Já existe um PK em andamento.');
        return;
      }
      const opponentId = typeof message?.opponentId === 'string' ? message.opponentId : this.cohostId;
      if (!opponentId || opponentId !== this.cohostId) {
        this.notify(client, 'pk_no_opponent', 'Nenhum co-host disponível para o PK.');
        return;
      }
      const opponentName = this.nameOf(opponentId) || (typeof message?.opponentName === 'string' ? message.opponentName : 'Oponente');
      const events = this.pk.start(
        { id: this.hostId, name: this.state.hostName || this.nameOf(this.hostId) },
        { id: opponentId, name: opponentName },
        `pk_${this.state.liveId}_${Date.now()}`,
      );
      this.state.isPK = true;
      this.pkStartedAt = Date.now();
      this.applyPKEvents(events);
      this.publishListing();
    });

    // --- palco: convite do host, aceite do convidado -----------------------
    this.onMessage(MSG.invite, (client, message: { userId?: unknown }) => {
      const identity = this.identityOf(client);
      if (!identity || identity.userId !== this.hostId) return;
      if (this.cohostId) {
        this.notify(client, 'stage_full', 'O palco já tem um co-host.');
        return;
      }
      const userId = typeof message?.userId === 'string' ? message.userId : '';
      const guest = this.clientOfUser(userId);
      if (!guest || userId === this.hostId) {
        this.notify(client, 'stage_no_guest', 'Esse espectador não está na live.');
        return;
      }
      this.invite = { userId, expiresAt: Date.now() + INVITE_TTL_MS };
      guest.send(MSG.stageInvite, {
        fromId: this.hostId,
        fromName: this.state.hostName,
        expiresAt: this.invite.expiresAt,
      });
    });

    this.onMessage(MSG.acceptStage, (client) => {
      const identity = this.identityOf(client);
      if (!identity) return;
      const invite = this.invite;
      // Three ways to fail, all of them silent-ish: no invite, someone else's
      // invite, or an expired one. None of them may promote anybody.
      if (!invite || invite.userId !== identity.userId || Date.now() > invite.expiresAt) {
        this.notify(client, 'stage_invalid', 'Convite inválido ou expirado.');
        return;
      }
      if (this.cohostId) {
        this.notify(client, 'stage_full', 'O palco já tem um co-host.');
        return;
      }
      this.invite = null;
      this.promoteToStage(client, identity);
    });

    this.onMessage(MSG.leaveStage, (client) => {
      const identity = this.identityOf(client);
      if (!identity || identity.userId !== this.cohostId) return;
      this.demoteFromStage(client, identity);
    });

    this.onMessage(MSG.endLive, (client) => {
      const identity = this.identityOf(client);
      if (!identity || identity.userId !== this.hostId) return;
      this.endLive('host_ended');
    });
  }

  private clientOfUser(userId: string): Client | undefined {
    if (!userId) return undefined;
    return this.clients.find((c) => this.identityOf(c)?.userId === userId);
  }

  /**
   * Gives a spectator a body and a seat. Promotion happens in place — the guest
   * is already connected, so there is no join option anywhere that could grant
   * a stage seat.
   */
  private promoteToStage(client: Client, identity: AuthIdentity): void {
    this.cohostId = identity.userId;
    this.spawnPlayer(client, identity);
    this.refreshViewers();
    this.systemChat(`${identity.displayName} entrou no palco.`);
  }

  private demoteFromStage(client: Client, identity: AuthIdentity): void {
    this.cohostId = '';
    if (this.pk.active) this.applyPKEvents(this.pk.abort('host_left'));
    this.despawnPlayer(client);
    this.refreshViewers();
    this.systemChat(`${identity.displayName} saiu do palco.`);
  }

  private nameOf(userId: string): string {
    for (const [, player] of this.state.players) {
      if (player.id === userId) return player.name;
    }
    return '';
  }

  /**
   * Gift pipeline. Read the order carefully — it is the economic contract:
   * validate shape, ask the API to charge, and only then let anything become
   * visible. A denial produces a private notice and no state change at all.
   */
  private async handleGift(client: Client, message: unknown): Promise<void> {
    const identity = this.identityOf(client);
    if (!identity) return;

    const msg = (typeof message === 'object' && message !== null ? message : {}) as Record<string, unknown>;
    const giftId = typeof msg.giftId === 'string' ? msg.giftId : '';
    const quantity = typeof msg.quantity === 'number' ? Math.trunc(msg.quantity) : 0;
    const idempotencyKey = typeof msg.idempotencyKey === 'string' ? msg.idempotencyKey : '';

    const gift = GIFT_BY_ID.get(giftId);
    if (!gift || !gift.active) {
      this.notify(client, 'gift_unknown', 'Presente indisponível.');
      return;
    }
    if (quantity < 1 || quantity > MAX_GIFT_QUANTITY) {
      this.notify(client, 'gift_quantity', 'Quantidade inválida.');
      return;
    }
    if (!idempotencyKey || idempotencyKey.length > IDEMPOTENCY_KEY_MAX) {
      // Without a key a retried socket message would charge twice; refuse
      // rather than mint one server-side, which would defeat the purpose.
      this.notify(client, 'gift_key', 'Envio inválido: chave ausente.');
      return;
    }

    const requested = typeof msg.receiverId === 'string' ? msg.receiverId : this.hostId;
    const receiverId = requested === this.cohostId && this.cohostId ? this.cohostId : this.hostId;
    if (receiverId === identity.userId) {
      this.notify(client, 'gift_self', 'Você não pode presentear a si mesmo.');
      return;
    }

    const charge = await this.economy.chargeGift({
      idempotencyKey,
      senderId: identity.userId,
      receiverId,
      giftId,
      quantity,
      liveId: this.apiLiveId,
      roomId: this.roomId,
    });

    if (!charge.ok) {
      this.notify(client, `gift_${charge.reason}`, charge.message);
      return;
    }
    // A replay is a duplicate delivery of a message already settled. The coins
    // were charged exactly once; broadcasting again would double the animation
    // and, worse, double the PK score.
    if (charge.replay) return;

    // The room may have been disposed while the HTTP charge was in flight.
    if (this.state.ended) return;

    const pkEvents = this.pk.addPointsForReceiver(receiverId, charge.pkPoints);
    this.applyPKEvents(pkEvents);

    this.state.coinsReceived += charge.coinsSpent;

    const sender = this.state.players.get(client.sessionId);
    if (sender) sender.gifterLevel = charge.gifterLevel;
    const receiverPlayer = this.playerByUserId(receiverId);
    if (receiverPlayer) receiverPlayer.anim = 'giftReact';

    const event: GiftEvent = {
      eventId: `${this.state.liveId}:${++this.giftSeq}`,
      senderId: identity.userId,
      senderName: identity.displayName,
      gifterLevel: charge.gifterLevel,
      giftId: gift.id,
      quantity,
      animationId: gift.animationId,
      receiverId,
      pkPoints: pkEvents.length > 0 ? charge.pkPoints : 0,
      timestamp: Date.now(),
    };
    this.broadcast(MSG.giftEvent, event);
  }

  private playerByUserId(userId: string) {
    for (const [, player] of this.state.players) {
      if (player.id === userId) return player;
    }
    return undefined;
  }

  /** Called by the API once a follow has been persisted (SPECs §34). */
  announceFollower(followerId: string, followerName: string): void {
    const event: FollowEvent = { followerId, followerName, timestamp: Date.now() };
    this.broadcast(MSG.follow, event);
  }

  private applyPKEvents(events: PKEvent[]): void {
    if (events.length === 0) return;
    const snap = this.pk.snapshot;
    this.state.pk.phase = snap.phase;
    this.state.pk.hostA = snap.hostA;
    this.state.pk.hostB = snap.hostB;
    this.state.pk.nameA = snap.nameA;
    this.state.pk.nameB = snap.nameB;
    this.state.pk.scoreA = snap.scoreA;
    this.state.pk.scoreB = snap.scoreB;
    this.state.pk.endsAt = snap.endsAt;
    this.state.pk.winnerId = snap.winnerId;

    for (const event of events) {
      if (event.kind !== 'finished') continue;
      this.settlePK(event.result, { hostA: snap.hostA, hostB: snap.hostB });
    }
  }

  private settlePK(result: PKResult, snapshot: { hostA: string; hostB: string }): void {
    this.state.isPK = false;
    for (const [, player] of this.state.players) {
      if (result.draw) player.anim = 'idle';
      else player.anim = player.id === result.winnerId ? 'pkWin' : 'pkLose';
    }
    this.broadcast(MSG.pkResult, result);
    this.systemChat(
      result.draw
        ? 'PK encerrado em empate.'
        : `PK encerrado: ${this.nameOf(result.winnerId) || 'host'} venceu por ${Math.abs(result.scoreA - result.scoreB)} pontos.`,
    );

    // The battle was decided here; the API is its memory (SPECs §33). The call
    // is idempotent by battleId, so a retry after a network blip cannot hand
    // out fame twice.
    void this.api.recordPKResult({
      ...result,
      hostA: snapshot.hostA,
      hostB: snapshot.hostB,
      streamId: this.apiLiveId,
      startedAt: this.pkStartedAt || null,
    });
    this.pkStartedAt = 0;
    this.publishListing();
  }

  protected override onTick(): void {
    this.applyPKEvents(this.pk.update());

    const now = Date.now();
    if (now - this.lastLikeFlush < LIKE_FLUSH_MS) return;
    this.lastLikeFlush = now;
    const totals = this.likes.flush();
    if (totals.delta === 0) return;
    this.state.likes = totals.total;
    const payload: LikeTotals = totals;
    this.broadcast(MSG.likeTotals, payload);
  }

  private endLive(reason: 'host_ended' | 'host_left'): void {
    if (this.state.ended) return;
    this.state.ended = true;
    this.state.isPK = false;
    this.autoDispose = true;
    this.lock();
    this.publishListing();
    this.systemChat(reason === 'host_ended' ? 'A live foi encerrada.' : 'O host saiu — live encerrada.');
    this.broadcast(MSG.notice, { code: 'live_ended', text: 'Esta live terminou.' });
    void this.api.closeLive({
      externalId: this.state.liveId,
      hostId: this.hostId,
      peakViewers: this.peakViewers,
      uniqueViewers: this.uniqueViewers.size,
      likes: this.state.likes,
    });
    // Give clients a beat to render the ending before the socket drops.
    this.clock.setTimeout(() => this.disconnect(), 1_500);
  }

  override onDispose(): void {
    const scene = SCENES[this.sceneId];
    console.log(`[live] ${this.state.liveId} encerrada em ${scene.name}; ${this.state.likes} likes, ${this.state.coinsReceived} coins.`);
  }
}
