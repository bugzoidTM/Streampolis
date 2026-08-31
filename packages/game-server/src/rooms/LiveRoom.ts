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
import type { AuthIdentity } from '../auth/AuthProvider.js';
import { config } from '../config.js';
import { defaultEconomyGateway, MAX_GIFT_QUANTITY, type EconomyGateway } from '../economy/EconomyGateway.js';
import { LikeAggregator } from '../social/LikeAggregator.js';
import { PKEngine, type PKEvent } from '../pk/PKEngine.js';
import { BaseWorldRoom, type RoomCreateOptions } from './BaseWorldRoom.js';
import { LiveState, type RoomRole } from './schema.js';

export interface LiveOptions extends RoomCreateOptions {
  liveId?: string;
  hostId?: string;
  hostName?: string;
  title?: string;
  category?: string;
  sceneId?: SceneId;
  agency?: string;
}

interface LiveJoinOptions {
  token?: string;
  /** Requested seat on the stage. Anything else joins as a spectator. */
  role?: 'cohost';
}

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
  private readonly likes = new LikeAggregator();
  private readonly pk = new PKEngine();
  /** Stage seats by userId, so a rejoin restores the seat, not the sessionId. */
  private hostId = '';
  private cohostId = '';
  private lastLikeFlush = 0;
  private giftSeq = 0;

  protected createState(): LiveState {
    return new LiveState();
  }

  override onCreate(options: LiveOptions = {}): void {
    if (options.sceneId && LIVE_SCENES.has(options.sceneId)) this.sceneId = options.sceneId;
    this.hostId = typeof options.hostId === 'string' ? options.hostId : '';
    if (!this.hostId) throw new ServerError(400, 'live_requires_host');

    super.onCreate({ ...options, capacity: config.liveCapacity });

    this.state.liveId = options.liveId || `live_${this.roomId}`;
    this.state.hostId = this.hostId;
    this.state.hostName = options.hostName ?? '';
    this.state.title = (options.title ?? '').slice(0, 80);
    this.state.category = options.category ?? 'geral';
    this.state.agency = options.agency ?? '';
    this.state.startedAt = Date.now();

    this.registerLiveMessages();
    this.publishListing();
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

    // TODO(api agent): a co-host seat should require an invite the API issued.
    // Until that exists the first claimant wins, which is enough for the PoC
    // and harmless — a co-host cannot spend or receive anything by itself.
    if (options.role === 'cohost' && identity && !this.cohostId && identity.userId !== this.hostId) {
      this.cohostId = identity.userId;
    }

    super.onJoin(client, options, auth);
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
      this.applyPKEvents(events);
      this.publishListing();
    });

    this.onMessage(MSG.endLive, (client) => {
      const identity = this.identityOf(client);
      if (!identity || identity.userId !== this.hostId) return;
      this.endLive('host_ended');
    });
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
      liveId: this.state.liveId,
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
      this.settlePK(event.result);
    }
  }

  private settlePK(result: PKResult): void {
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
    // TODO(api agent): POST the result so fame and PK history persist. The
    // battle is authoritative here; the API only records it.
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
    // Give clients a beat to render the ending before the socket drops.
    this.clock.setTimeout(() => this.disconnect(), 1_500);
  }

  override onDispose(): void {
    const scene = SCENES[this.sceneId];
    console.log(`[live] ${this.state.liveId} encerrada em ${scene.name}; ${this.state.likes} likes, ${this.state.coinsReceived} coins.`);
  }
}
