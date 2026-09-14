import { isAddressed, sanitizeSay } from './brain.js';
import { GATHER, GATHERINGS, type Gathering } from './gatherings.js';
import { claim, decide, namesAny, type Candidate } from './arbiter.js';
import { log, warn } from './log.js';
import { mulberry32, seedOf, type Mind } from './mind.js';
import { bearing, findPlace, placesOf } from './places.js';
import { Relations, atLeast, stageOf, type Relation, type Stage } from './relations.js';
import type { Personality, SocialProfile } from './roster.js';
import { SCENE_LABEL, nearestFree, sceneKnowledge } from './scenes.js';
import { freeSeatNear } from './seats.js';
import type { ChatMessage, SceneId } from './shared.js';
import { composer, detect, greetKey, partOfDay, type Composer, type Slots } from './speech.js';
import type { Point } from './walker.js';
import type { Nearby, World } from './world.js';

/**
 * O personagem social: parece ter vontade própria, e tem — dentro de uma
 * caixa de possibilidades que este arquivo controla.
 *
 * A caixa tem quatro paredes:
 *
 *   1. **Personalidade** (cinco números, do perfil no banco) — não muda nunca.
 *   2. **Humor** (valência e energia) — muda com o que acontece e volta à base
 *      da personalidade com o tempo.
 *   3. **Necessidades** (companhia) — sobem sozinhas e caem quando atendidas.
 *   4. **Relações** (`relations.ts`) — com jogadores e com outros personagens
 *      sociais; crescem com presença e conversa, esfriam com ausência, viram
 *      ressentimento com grosseria. Persistem.
 *
 * A cada tique, quando o corpo está livre, uma pontuação de utilidade escolhe
 * a próxima atividade numa LISTA FECHADA (passear, ir ao canto preferido,
 * sentar, observar, dançar, ir cumprimentar alguém, ir ao encontro de um
 * amigo personagem). A fala vem de `speech.ts`: intenção por regra, resposta
 * por modelo de frase. Nenhuma chamada a modelo de linguagem, em nenhum
 * caminho — o que este personagem diz e faz é enumerável.
 *
 * O diferencial da classe é a relação: um desconhecido que pede "vem comigo"
 * ouve não; um amigo, sim. Quem xinga um personagem impaciente vê ele ir
 * embora e ficar sem resposta por cinco minutos. Quem volta três dias seguidos
 * é reconhecido de longe. Tudo isso é número, e tudo é testável.
 */

const NEAR_TALK_M = 4.5;
const CONVERSATION_TTL_MS = 60_000;
const REPLY_DEBOUNCE_MS = 1_500;
const MIN_GAP_PER_USER_MS = 4_000;
const MAX_REPLIES_PER_USER_10MIN = 12;
const MAX_REPLIES_PER_MIN = 6;
const GREET_COOLDOWN_MS = 15 * 60_000;
const MEET_COOLDOWN_MS = 10 * 60_000;
const APPROACH_COOLDOWN_MS = 10 * 60_000;
const SPONTANEOUS_GAP_MS = 8 * 60_000;
const ROOM_SPONTANEOUS_GAP_MS = 75_000;
const QUIET_MS = 3 * 60_000;
const SPONTANEOUS_RADIUS_M = 8;
const FOLLOW_TTL_MS = 3 * 60_000;
const IGNORE_AFTER_INSULT_MS = 5 * 60_000;
const PEER_AFFINITY_PER_TICK = 0.02;
const PEER_NEAR_M = 6;
const MAX_SAY = 180;

/** Última fala espontânea de QUALQUER personagem social por sala: um por vez, não um coro. */
const roomSpontaneousAt = new Map<string, number>();
/** Os personagens sociais deste processo, para o encontro entre dois deles ter os dois lados. */
export const SOCIAL_PEERS = new Map<string, SocialMind>();

type Activity =
  | { kind: 'idle'; until: number }
  | { kind: 'wander'; until: number; arrived: boolean }
  | { kind: 'haunt'; at: Point; until: number; arrived: boolean }
  | { kind: 'sit'; until: number; arrived: boolean }
  | { kind: 'dance'; until: number; arrived: boolean }
  | { kind: 'watch'; at: Point; until: number; arrived: boolean }
  | { kind: 'approach'; userId: string; name: string; until: number; greeted: boolean }
  | { kind: 'meet'; peerId: string; name: string; until: number; arrived: boolean; spoke: boolean }
  | { kind: 'gather'; g: Gathering; slot: Point; until: number; arrived: boolean; nextGestureAt: number }
  | { kind: 'follow'; userId: string; name: string; until: number }
  | { kind: 'guide'; userId: string; name: string; place: string; until: number }
  | { kind: 'leave'; until: number };

interface Conversation {
  userId: string;
  name: string;
  lastAt: number;
  replies: number[];
  pending: { texts: string[]; timer: NodeJS.Timeout } | null;
}

const SCENE_LINE: Partial<Record<SceneId, string>> = {
  central_plaza: 'Um monumento no meio, bancos em volta, um telão que passa o mesmo vídeo o dia todo, e portas para a loja, as torres e o Distrito Sombra.',
  noir_district: 'Duas ruas de madrugada, néon, chuva fina, bicos pagos em Credits e o Clube Sombra. Nada abre, exceto o clube.',
  noir_club: 'Uma discoteca: pista, DJ, luz colorida. Aqui se dança, não se conversa muito.',
  residential_lobby: 'O saguão das torres. Os elevadores levam ao apartamento de cada um.',
  stream_store: 'A loja de visuais e itens. Quem compra é você, na tela — eu só olho.',
  agency_tower: 'A torre das agências de streamers. Mesas, gente ocupada, e eu.',
};

const STAGE_WEIGHT: Record<Stage, number> = { grudge: 0, stranger: 0.15, known: 0.4, friend: 0.7, close: 0.9 };

export function compatibility(a: Personality, b: Personality): number {
  const d = Math.abs(a.sociable - b.sociable) + Math.abs(a.curious - b.curious) + Math.abs(a.cheerful - b.cheerful)
    + Math.abs(a.patient - b.patient) * 0.5 + Math.abs(a.loyal - b.loyal) * 0.5;
  return Math.max(0.1, 1 - d / 4);
}

export class SocialMind implements Mind {
  readonly rng: () => number;
  readonly relations: Relations;
  private readonly talk: Composer;
  /** Humor: valência (−1..1) e energia (0..1), com base na personalidade. */
  mood = { valence: 0, energy: 0.6 };
  /** Necessidade de companhia (0..1): sobe sozinha, cai quando atendida. */
  socialNeed = 0.4;
  private activity: Activity = { kind: 'idle', until: 0 };
  private conversations = new Map<string, Conversation>();
  private repliesAt: number[] = [];
  private greetCandidates = new Map<string, Nearby>();
  private metAt = new Map<string, number>();
  private approachedAt = new Map<string, number>();
  private ignoreUntil = new Map<string, number>();
  private lastAnyChatAt = 0;
  private lastSpokeAt = 0;
  private lastSpontaneousAt = 0;
  private gatherCooldownUntil = 0;
  private gestureTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null;
  private readonly p: Personality;

  constructor(
    readonly npc: { id: string; name: string; sceneId: SceneId },
    private world: World,
    readonly profile: SocialProfile,
  ) {
    this.rng = mulberry32(seedOf(npc.id));
    this.p = profile.personality;
    this.relations = new Relations(npc.id, this.p.loyal);
    this.talk = composer(profile.archetype, profile.intro, SCENE_LINE[npc.sceneId] ?? '', this.rng);
    this.mood.valence = this.baseValence;
    this.flushTimer = setInterval(() => void this.relations.flush().catch(() => {}), 30_000);
    this.flushTimer.unref?.();
    SOCIAL_PEERS.set(npc.id, this);
  }

  private get baseValence(): number {
    return (this.p.cheerful - 0.5) * 1.2;
  }

  private get here(): string {
    return SCENE_LABEL[this.npc.sceneId];
  }

  rebind(world: World): void {
    this.world = world;
    this.activity = { kind: 'idle', until: 0 };
    this.greetCandidates.clear();
  }

  status(): Record<string, unknown> {
    const rels = this.relations.all();
    const stages: Record<string, number> = {};
    for (const r of rels) stages[stageOf(r.affinity)] = (stages[stageOf(r.affinity)] ?? 0) + 1;
    return {
      archetype: this.profile.archetype,
      mood: { valence: Math.round(this.mood.valence * 100) / 100, energy: Math.round(this.mood.energy * 100) / 100 },
      socialNeed: Math.round(this.socialNeed * 100) / 100,
      activity: this.activity.kind + ('name' in this.activity ? ` ${this.activity.name}` : ''),
      relations: rels.length,
      stages,
      conversations: this.conversations.size,
    };
  }

  // ------------------------------------------------------------ percepção

  onAppeared(p: Nearby): void {
    const now = Date.now();
    if (now - (this.metAt.get(p.userId) ?? 0) < MEET_COOLDOWN_MS) return;
    this.metAt.set(p.userId, now);
    if (p.npc) {
      // Outro personagem SOCIAL: relação entre personagens. Os de outras classes não contam.
      if (!SOCIAL_PEERS.has(p.userId)) return;
      void this.relations.get(p.userId, 'npc', p.name).then((rel) => this.relations.meet(rel)).catch(() => {});
      return;
    }
    void this.relations.get(p.userId, 'player', p.name).then((rel) => {
      this.relations.meet(rel);
      const stage = stageOf(rel.affinity);
      if (atLeast(stage, 'known') && now - rel.lastGreetedAt > GREET_COOLDOWN_MS) {
        this.greetCandidates.set(p.userId, p);
        if (stage !== 'grudge') this.nudgeMood(0.1 * (1 + this.p.loyal));
      }
    }).catch((err) => warn('social', 'não registrou encontro', { err: String(err) }));
  }

  onGone(p: Nearby): void {
    this.greetCandidates.delete(p.userId);
    const a = this.activity;
    if ((a.kind === 'follow' || a.kind === 'guide' || a.kind === 'approach') && a.userId === p.userId) this.setActivity({ kind: 'idle', until: 0 });
    if (a.kind === 'meet' && a.peerId === p.userId) this.setActivity({ kind: 'idle', until: 0 });
  }

  onNotice(code: string, text: string): void {
    if (code.startsWith('chat_')) warn('social', 'fala recusada pelo servidor', { npc: this.npc.name, code, text });
  }

  onChat(msg: ChatMessage): void {
    if (msg.system || msg.senderId === this.npc.id) return;
    if (msg.npc) return;
    this.lastAnyChatAt = Date.now();
    const now = Date.now();
    if ((this.ignoreUntil.get(msg.senderId) ?? 0) > now) return;
    const speaker = this.world.people().find((p) => p.userId === msg.senderId);
    if (!this.shouldAnswer(msg, speaker ?? null)) return;
    this.queueReply(msg.senderId, msg.senderName, msg.text, speaker ?? null);
  }

  /**
   * Esta fala é para mim? Pelo nome, sim. Sem nome, o árbitro do processo
   * (`arbiter.ts`) escolhe UM personagem: quem já conversa com a pessoa, ou
   * quem ela está encarando. Antes, todo social a 4,5 m respondia junto — numa
   * rodinha, três "oi" para um.
   */
  private shouldAnswer(msg: ChatMessage, speaker: (Nearby & { distance: number }) | null): boolean {
    if (isAddressed(msg.text, this.npc.name)) return true;
    const others = this.world.people().filter((p) => p.npc);
    if (namesAny(msg.text, others.map((p) => p.name))) return false;
    if (!speaker) return false;
    const candidates: Candidate[] = others.map((p) => ({ npcId: p.userId, x: p.x, z: p.z }));
    const me = this.world.position;
    if (me) candidates.push({ npcId: this.npc.id, x: me.x, z: me.z });
    return decide(msg.id, msg.senderId, { x: speaker.x, z: speaker.z, yaw: speaker.yaw }, candidates) === this.npc.id;
  }

  // ---------------------------------------------------------------- tique

  tick(): void {
    const me = this.world.position;
    if (!me) return;
    const now = Date.now();
    this.drift(me.moving);
    this.peerAffinity();
    this.maybeSpontaneous(now);

    const walker = this.world.walker;
    if (walker.attending) return;

    // Cumprimentar quem chegou perto vira uma aproximação: ele VAI até a pessoa.
    if (this.activity.kind === 'idle' || this.activity.kind === 'wander' || this.activity.kind === 'haunt' || this.activity.kind === 'watch') {
      for (const [userId, cand] of [...this.greetCandidates]) {
        const p = this.world.people().find((x) => x.userId === userId);
        if (!p || p.distance > 14) continue;
        this.greetCandidates.delete(userId);
        this.setActivity({ kind: 'approach', userId, name: cand.name, until: now + 45_000, greeted: false });
        break;
      }
    }

    this.step(me, now);
  }

  /** Humor e necessidades andam sozinhos. */
  private drift(moving: boolean): void {
    // Valência volta à base em ~10 min (tique de 2 s: 300 tiques).
    this.mood.valence += (this.baseValence - this.mood.valence) * (1 / 300);
    this.mood.energy = Math.max(0.1, Math.min(1, this.mood.energy + (moving ? -0.006 : 0.01)));
    this.socialNeed = Math.min(1, this.socialNeed + 0.004 * (0.5 + this.p.sociable));
  }

  private nudgeMood(delta: number): void {
    this.mood.valence = Math.max(-1, Math.min(1, this.mood.valence + delta));
  }

  /** Personagens sociais que ficam perto um do outro se afeiçoam — na medida em que combinam. */
  private peerAffinity(): void {
    for (const p of this.world.people()) {
      if (!p.npc || p.distance > PEER_NEAR_M) continue;
      const peer = SOCIAL_PEERS.get(p.userId);
      if (!peer) continue;
      const rel = this.relations.peek(p.userId);
      if (!rel) continue;
      if (rel.affinity >= 60) continue;
      this.relations.bump(rel, PEER_AFFINITY_PER_TICK * compatibility(this.p, peer.p), false);
    }
  }

  private setActivity(a: Activity): void {
    const walker = this.world.walker;
    const prev = this.activity;
    if (prev.kind === 'sit' || prev.kind === 'dance') { walker.hold = 'free'; this.world.pose = null; }
    if (prev.kind === 'gather' && a !== prev) {
      GATHERINGS.leave(prev.g, this.npc.id);
      this.gatherCooldownUntil = Date.now() + GATHER.cooldownMs;
    }
    if (a.kind !== 'follow' && a.kind !== 'guide') walker.release();
    this.activity = a;
    // Só o que envolve alguém vai ao log: passear e sentar a cada minuto seriam ruído.
    if ('name' in a || a.kind === 'leave') log('social', 'atividade', { npc: this.npc.name, kind: a.kind, who: 'name' in a ? a.name : undefined });
  }

  private secs(a: number, b: number): number {
    return (a + this.rng() * (b - a)) * 1000;
  }

  /** As pernas por atividade; ao terminar, escolhe a próxima pela utilidade. */
  private step(me: NonNullable<World['position']>, now: number): void {
    const walker = this.world.walker;
    const a = this.activity;
    const arrivedAt = (p: Point, r = 1.2) => Math.hypot(p.x - me.x, p.z - me.z) <= r;

    switch (a.kind) {
      case 'idle':
        if (now >= a.until) this.choose(me, now);
        return;
      case 'wander':
        if (!a.arrived && walker.idle) { a.arrived = true; a.until = now + this.secs(10, 35); }
        if (a.arrived && now >= a.until) this.choose(me, now);
        return;
      case 'haunt':
      case 'watch':
        if (!a.arrived && (walker.idle || arrivedAt(a.at, 1.5))) {
          a.arrived = true;
          a.until = now + (a.kind === 'haunt' ? this.secs(60, 180) : this.secs(45, 120));
          walker.stayAt(arrivedAt(a.at, 2.5) ? a.at : { x: me.x, z: me.z });
          if (a.kind === 'watch') this.world.faceTo(a.at);
        }
        if (a.arrived && now >= a.until) this.choose(me, now);
        return;
      case 'sit':
        if (!a.arrived && walker.seated) { a.arrived = true; a.until = now + this.secs(90, 240); walker.hold = 'seated'; }
        if (!a.arrived && !walker.sitting) { this.choose(me, now); return; }
        if (a.arrived && now >= a.until) { walker.standUp(); this.choose(me, now); }
        return;
      case 'dance':
        if (!a.arrived && walker.idle) {
          a.arrived = true;
          a.until = now + this.secs(60, 180);
          walker.stayAt({ x: me.x, z: me.z });
          this.world.pose = 'dance';
          walker.hold = 'gesture';
        }
        if (a.arrived && now >= a.until) this.choose(me, now);
        return;
      case 'approach': {
        const who = this.world.personAt(a.userId);
        if (!who || now > a.until) { this.choose(me, now); return; }
        const d = Math.hypot(who.x - me.x, who.z - me.z);
        if (!a.greeted) {
          if (d <= 3) {
            a.greeted = true;
            a.until = now + 20_000;
            this.approachedAt.set(a.userId, now);
            walker.stop();
            this.world.attend(a.userId, 8_000);
            void this.greetNow(a.userId, a.name);
          } else if (walker.idle) {
            walker.setTarget(this.spotNear(who, me, 2.2));
          }
          return;
        }
        if (now >= a.until) this.choose(me, now);
        return;
      }
      case 'meet': {
        const peer = this.world.personAt(a.peerId);
        if (!peer || now > a.until) { this.choose(me, now); return; }
        const d = Math.hypot(peer.x - me.x, peer.z - me.z);
        if (!a.arrived) {
          if (d <= 2.6) {
            a.arrived = true;
            a.until = now + this.secs(40, 90);
            walker.stop();
            this.world.attend(a.peerId, a.until - now);
            SOCIAL_PEERS.get(a.peerId)?.attendedBy(this, a.until - now);
            this.socialNeed = Math.max(0, this.socialNeed - 0.5);
            const rel = this.relations.peek(a.peerId);
            if (rel) this.relations.bump(rel, 1, false);
          } else if (walker.idle) {
            walker.setTarget(this.spotNear(peer, me, 1.8));
          }
          return;
        }
        if (!a.spoke) {
          // Duas falas, só com gente para ouvir, e uma dupla por vez na sala.
          a.spoke = true;
          const humanNear = this.world.people().some((p) => !p.npc && p.distance <= 12);
          if (humanNear && this.roomGate(now)) {
            const other = SOCIAL_PEERS.get(a.peerId);
            const line = this.talk.say('meet_npc_a', a.peerId, this.slots(a.name, null, { other: a.name }));
            if (line && this.speak(line)) {
              this.markSpontaneous(now);
              other?.replyToPeer(this.npc.name, this.npc.id);
            }
          }
        }
        if (now >= a.until) this.choose(me, now);
        return;
      }
      case 'gather': {
        if (now >= a.until || !GATHERINGS.alive(a.g, now)) { this.choose(me, now); return; }
        const d = Math.hypot(a.slot.x - me.x, a.slot.z - me.z);
        if (!a.arrived) {
          if (d <= 0.9 || (walker.idle && d <= 2.0)) {
            a.arrived = true;
            walker.stayAt(d <= 2.0 ? a.slot : { x: me.x, z: me.z });
            this.world.faceTo(a.g.center);
            a.nextGestureAt = now + 8_000 + this.rng() * 20_000;
            this.socialNeed = Math.max(0, this.socialNeed - 0.3);
          } else if (walker.idle) {
            this.choose(me, now);
          }
          return;
        }
        // Sozinho na rodinha por mais de meio minuto: vai embora.
        if (a.g.members.size <= 1 && now - a.g.openedAt > 30_000 && this.rng() < 0.2) { this.choose(me, now); return; }
        if (now >= a.nextGestureAt) {
          a.nextGestureAt = now + 15_000 + this.rng() * 30_000;
          walker.emote(this.rng() < 0.5 ? 'wave' : 'clap');
          if (this.gestureTimer) clearTimeout(this.gestureTimer);
          this.gestureTimer = setTimeout(() => { this.gestureTimer = null; walker.emote('idle'); }, 3_000);
        }
        return;
      }
      case 'follow': {
        const who = this.world.personAt(a.userId);
        if (!who || now > a.until) { this.choose(me, now); return; }
        if (!walker.following) walker.follow(this.world.tracker(a.userId));
        return;
      }
      case 'guide': {
        const place = placesOf(this.npc.sceneId).find((p) => p.name === a.place);
        if (!place || now > a.until || (walker.idle && arrivedAt(place.standing, 1.5))) { this.setActivity({ kind: 'idle', until: now + 20_000 }); return; }
        if (walker.idle) walker.guide(place.standing, this.world.tracker(a.userId));
        return;
      }
      case 'leave':
        if (walker.idle || now > a.until) this.choose(me, now);
        return;
    }
  }

  /** Um ponto a `r` m de alguém, do lado de cá, livre. */
  private spotNear(who: Point, me: Point, r: number): Point {
    const dx = me.x - who.x;
    const dz = me.z - who.z;
    const d = Math.hypot(dx, dz) || 1;
    return nearestFree(this.npc.sceneId, { x: who.x + (dx / d) * r, z: who.z + (dz / d) * r });
  }

  /**
   * A escolha. Pontuação por atividade, com ruído do gerador do personagem:
   * a personalidade puxa, o humor e a necessidade empurram, as relações
   * abrem opções que não existem para desconhecidos.
   */
  private choose(me: Point, now: number): void {
    const jitter = () => this.rng() * 0.25;
    const k = sceneKnowledge(this.npc.sceneId);
    const options: Array<{ score: number; go: () => void }> = [];
    const energy = this.mood.energy;

    options.push({ score: 0.25 + this.p.curious * 0.35 + energy * 0.2 + jitter(), go: () => {
      this.setActivity({ kind: 'wander', until: 0, arrived: false });
      this.world.walker.pickDestination(me, this.rng);
    } });
    if (this.profile.haunts.length) {
      options.push({ score: 0.2 + (1 - this.p.sociable) * 0.25 + (1 - energy) * 0.35 + jitter(), go: () => {
        const at = nearestFree(this.npc.sceneId, this.profile.haunts[Math.floor(this.rng() * this.profile.haunts.length)]!);
        this.setActivity({ kind: 'haunt', at, until: 0, arrived: false });
        if (Math.hypot(at.x - me.x, at.z - me.z) > 1.5) this.world.walker.setTarget(at);
      } });
    }
    if (k.seats.length) {
      options.push({ score: (1 - energy) * 0.6 + this.p.patient * 0.15 + jitter(), go: () => {
        const occupied = this.world.people().map((p) => ({ x: p.x, z: p.z }));
        const seat = freeSeatNear(k.seats, me, occupied) ?? freeSeatNear(k.seats, k.destinations[Math.floor(this.rng() * k.destinations.length)] ?? me, occupied);
        if (!seat) { this.setActivity({ kind: 'idle', until: now + 5_000 }); return; }
        this.setActivity({ kind: 'sit', until: 0, arrived: false });
        this.world.walker.sitAt({ at: seat.at, yaw: seat.yaw });
      } });
    }
    if (this.npc.sceneId === 'noir_club') {
      options.push({ score: this.p.cheerful * 0.5 + energy * 0.4 + jitter(), go: () => {
        const ang = this.rng() * Math.PI * 2;
        const r = 1.5 + this.rng() * 4;
        const at = nearestFree('noir_club', { x: Math.cos(ang) * r, z: -1 + Math.sin(ang) * r });
        this.setActivity({ kind: 'dance', until: 0, arrived: false });
        this.world.walker.setTarget(at);
      } });
    }
    if (this.npc.sceneId === 'central_plaza') {
      const screen = placesOf('central_plaza').find((p) => p.name === 'o telão');
      if (screen) {
        options.push({ score: this.p.curious * 0.35 + 0.1 + jitter(), go: () => {
          const at = nearestFree('central_plaza', { x: screen.standing.x + (this.rng() - 0.5) * 6, z: screen.standing.z + (this.rng() - 0.5) * 3 });
          this.setActivity({ kind: 'watch', at: screen.at, until: 0, arrived: false });
          this.world.walker.setTarget(at);
        } });
      }
    }
    // Uma rodinha (2–3 personagens num ponto social): entrar numa aberta, ou abrir uma.
    const room = this.world.roomId;
    if (room && now >= this.gatherCooldownUntil) {
      const open = GATHERINGS.joinable(room, me, 25, now);
      const canOpen = !open && GATHERINGS.inRoom(room).length < GATHER.maxPerRoom && this.rng() < 0.3;
      if (open || canOpen) {
        options.push({ score: 0.3 * (0.3 + this.p.sociable) * (0.5 + this.socialNeed) * (open ? 1.3 : 1) + jitter(), go: () => {
          const g = open ?? GATHERINGS.open(this.npc.sceneId, room, me, 25, this.rng, now);
          const slot = g ? GATHERINGS.join(g, this.npc.id) : null;
          if (!g || !slot) { this.setActivity({ kind: 'idle', until: now + 5_000 }); return; }
          const until = Math.min(g.until, now + 90_000 + this.rng() * 150_000);
          this.setActivity({ kind: 'gather', g, slot, until, arrived: false, nextGestureAt: 0 });
          this.world.walker.setTarget(slot);
        } });
      }
    }
    for (const person of this.world.people()) {
      if (person.distance > 20) continue;
      if (now - (this.approachedAt.get(person.userId) ?? 0) < APPROACH_COOLDOWN_MS) continue;
      const rel = this.relations.peek(person.userId);
      if (!rel) continue;
      const stage = stageOf(rel.affinity);
      if (person.npc) {
        const peer = SOCIAL_PEERS.get(person.userId);
        if (!peer || !atLeast(stage, 'known') || person.distance > 25) continue;
        const score = 0.25 * (0.3 + this.p.loyal) * (0.5 + this.socialNeed) * compatibility(this.p, peer.p) * 2 + jitter();
        options.push({ score, go: () => {
          this.approachedAt.set(person.userId, now);
          this.setActivity({ kind: 'meet', peerId: person.userId, name: person.name, until: now + 60_000, arrived: false, spoke: false });
        } });
        continue;
      }
      if ((this.ignoreUntil.get(person.userId) ?? 0) > now) continue;
      const score = STAGE_WEIGHT[stage] * (0.4 + this.p.sociable * 0.8) * (0.5 + this.socialNeed) + jitter();
      options.push({ score, go: () => {
        this.setActivity({ kind: 'approach', userId: person.userId, name: person.name, until: now + 45_000, greeted: false });
      } });
    }
    options.sort((x, y) => y.score - x.score);
    options[0]!.go();
  }

  // ---------------------------------------------------------------- falas

  private slots(name: string, rel: Relation | null, extra: Partial<Slots> = {}): Slots {
    const topics = this.profile.topics;
    return {
      name, npc: this.npc.name, scene: this.here, time: partOfDay(),
      fact: rel?.facts[rel.facts.length - 1],
      quirk: this.profile.quirk,
      topic: topics.length ? topics[Math.floor(this.rng() * topics.length)] : undefined,
      encountersN: rel?.encounters ?? 1,
      ...extra,
    };
  }

  private speak(text: string): boolean {
    const clean = sanitizeSay(text.slice(0, MAX_SAY));
    if (!clean) return false;
    const ok = this.world.say(clean);
    if (ok) this.lastSpokeAt = Date.now();
    return ok;
  }

  private roomGate(now: number): boolean {
    const room = this.world.roomId ?? '';
    return now - (roomSpontaneousAt.get(room) ?? 0) >= ROOM_SPONTANEOUS_GAP_MS;
  }

  private markSpontaneous(now: number): void {
    roomSpontaneousAt.set(this.world.roomId ?? '', now);
    this.lastSpontaneousAt = now;
  }

  /** Uma frase sem ninguém ter perguntado: só com gente perto, sala quieta e vez na fila da sala. */
  private maybeSpontaneous(now: number): void {
    if (this.activity.kind === 'approach' || this.activity.kind === 'meet') return;
    if (now - this.lastSpontaneousAt < SPONTANEOUS_GAP_MS || now - this.lastSpokeAt < QUIET_MS) return;
    if (now - this.lastAnyChatAt < QUIET_MS) return;
    if (!this.roomGate(now)) return;
    const humans = this.world.people().filter((p) => !p.npc && p.distance <= SPONTANEOUS_RADIUS_M);
    if (!humans.length) return;
    if (this.rng() > this.p.sociable * 0.5) { this.lastSpontaneousAt = now - SPONTANEOUS_GAP_MS + 60_000; return; }
    const line = this.talk.say('spontaneous', '*', this.slots(humans[0]!.name, null));
    if (line && this.speak(line)) this.markSpontaneous(now);
  }

  private async greetNow(userId: string, name: string): Promise<void> {
    try {
      const rel = await this.relations.get(userId, 'player', name);
      const stage = stageOf(rel.affinity);
      const line = this.talk.say(greetKey(stage), userId, this.slots(name, rel));
      if (line && this.speak(line)) {
        claim(userId, this.npc.id);
        this.relations.greeted(rel);
        this.socialNeed = Math.max(0, this.socialNeed - 0.4);
      }
    } catch (err) {
      warn('social', 'falha ao cumprimentar', { err: String(err) });
    }
  }

  /** O outro lado de um encontro entre personagens: vira-se para quem chegou. */
  attendedBy(other: SocialMind, ms: number): void {
    this.world.attend(other.npc.id, ms);
    this.socialNeed = Math.max(0, this.socialNeed - 0.3);
  }

  /** A segunda fala do encontro, uns segundos depois da primeira. */
  replyToPeer(otherName: string, otherId: string): void {
    setTimeout(() => {
      const line = this.talk.say('meet_npc_b', otherId, this.slots(otherName, null, { other: otherName }));
      if (line) this.speak(line);
    }, 3_000 + this.rng() * 2_000);
  }

  private queueReply(userId: string, name: string, text: string, speaker: (Nearby & { distance: number }) | null): void {
    let c = this.conversations.get(userId);
    if (!c) {
      c = { userId, name, lastAt: Date.now(), replies: [], pending: null };
      this.conversations.set(userId, c);
    }
    c.name = name;
    c.lastAt = Date.now();
    if (speaker && this.activity.kind !== 'follow' && this.activity.kind !== 'guide') this.world.attend(userId, 20_000);
    if (c.pending) { c.pending.texts.push(text); return; }
    const timer = setTimeout(() => {
      const texts = c!.pending?.texts ?? [text];
      c!.pending = null;
      void this.reply(c!, texts.join(' '));
    }, REPLY_DEBOUNCE_MS);
    c.pending = { texts: [text], timer };
  }

  private allowReply(c: Conversation): boolean {
    const now = Date.now();
    this.repliesAt = this.repliesAt.filter((t) => now - t < 60_000);
    if (this.repliesAt.length >= MAX_REPLIES_PER_MIN) return false;
    c.replies = c.replies.filter((t) => now - t < 10 * 60_000);
    if (c.replies.length >= MAX_REPLIES_PER_USER_10MIN) return false;
    const last = c.replies[c.replies.length - 1] ?? 0;
    if (now - last < MIN_GAP_PER_USER_MS) return false;
    this.repliesAt.push(now);
    c.replies.push(now);
    return true;
  }

  /** O coração da caixa: intenção → efeito na relação/humor → ação do corpo → frase. */
  async reply(c: Conversation, text: string): Promise<void> {
    if (!this.allowReply(c)) return;
    const me = this.world.position;
    if (!me) return;
    const now = Date.now();
    try {
      const det = detect(text);
      const rel = await this.relations.get(c.userId, 'player', c.name);
      const stageBefore = stageOf(rel.affinity);
      const low = this.mood.valence < -0.3;
      const sour = low && this.p.patient < 0.5;
      let key: string | null = null;
      const extra: Partial<Slots> = {};
      let delta = 0;
      let followUp: string | null = null;

      switch (det.intent) {
        case 'greet': key = greetKey(stageBefore); delta = 1; break;
        case 'bye':
          key = atLeast(stageBefore, 'friend') ? 'bye_friend' : 'bye';
          delta = 0.5;
          if ((this.activity.kind === 'follow' || this.activity.kind === 'guide') && this.activity.userId === c.userId) this.setActivity({ kind: 'idle', until: now + 10_000 });
          break;
        case 'how_are_you': key = low ? 'how_are_you_low' : 'how_are_you'; delta = 0.5; break;
        case 'who_are_you': key = 'who_are_you'; break;
        case 'are_you_real': key = 'are_you_real'; break;
        case 'what_place': key = 'what_place'; break;
        case 'where_is': {
          const place = findPlace(det.placeText ?? text, me, this.npc.sceneId);
          if (place) { key = 'where_is_known'; extra.place = place.name; extra.bearing = bearing(me, place.at); }
          else key = 'where_is_unknown';
          break;
        }
        case 'what_time': key = 'what_time'; break;
        case 'compliment': key = low ? 'compliment_low' : 'compliment'; delta = 3; this.nudgeMood(0.3); break;
        case 'insult': {
          const hit = 6 * (1.5 - this.p.patient);
          this.relations.bump(rel, -hit, false);
          this.nudgeMood(-0.5 * (1.5 - this.p.patient));
          key = stageBefore === 'grudge' ? 'insult_grudge' : this.p.patient > 0.65 ? 'insult_patient' : 'insult';
          if (this.p.patient < 0.4) {
            // Impaciente: vai embora e não responde a essa pessoa por um tempo.
            this.ignoreUntil.set(c.userId, now + IGNORE_AFTER_INSULT_MS);
            this.setActivity({ kind: 'leave', until: now + 40_000 });
            const far = sceneKnowledge(this.npc.sceneId).destinations
              .filter((d) => Math.hypot(d.x - me.x, d.z - me.z) > 12);
            if (far.length) this.world.walker.setTarget(far[Math.floor(this.rng() * far.length)]!);
          }
          break;
        }
        case 'thanks': key = 'thanks'; delta = 1.5; break;
        case 'laugh': key = 'laugh'; delta = 1; this.nudgeMood(0.1); break;
        case 'follow_me': {
          // Só quem já é conhecido — com uma exceção rara para o muito sociável, que é o que faz a regra parecer gente e não catraca.
          const willing = stageBefore !== 'grudge' && (atLeast(stageBefore, 'known') || (this.p.sociable > 0.9 && this.rng() < 0.2));
          if (stageBefore === 'grudge') key = 'follow_decline_grudge';
          else if (willing) {
            key = 'follow_accept'; delta = 1;
            this.setActivity({ kind: 'follow', userId: c.userId, name: c.name, until: now + FOLLOW_TTL_MS });
            this.world.walker.follow(this.world.tracker(c.userId));
          } else key = 'follow_decline';
          break;
        }
        case 'stay': key = 'stay_ok'; this.setActivity({ kind: 'idle', until: now + 60_000 }); this.world.walker.stayAt({ x: me.x, z: me.z }); break;
        case 'stop_follow': key = 'stop_ok'; this.setActivity({ kind: 'idle', until: now + 15_000 }); break;
        case 'take_me': {
          const place = findPlace(det.placeText ?? text, me, this.npc.sceneId);
          if (!place) key = 'take_me_unknown';
          else {
            extra.place = place.name; extra.bearing = bearing(me, place.at);
            if (atLeast(stageBefore, 'friend')) {
              key = 'take_me_accept'; delta = 1;
              this.setActivity({ kind: 'guide', userId: c.userId, name: c.name, place: place.name, until: now + FOLLOW_TTL_MS });
              this.world.walker.guide(place.standing, this.world.tracker(c.userId));
            } else key = 'take_me_decline';
          }
          break;
        }
        case 'sit': {
          const k = sceneKnowledge(this.npc.sceneId);
          if (!k.seats.length) { key = 'sit_no'; break; }
          const who = this.world.personAt(c.userId) ?? me;
          const occupied = this.world.people().map((p) => ({ x: p.x, z: p.z }));
          const seat = freeSeatNear(k.seats, who, occupied);
          if (seat && (this.p.sociable > 0.5 || atLeast(stageBefore, 'known'))) {
            key = 'sit_ok'; delta = 0.5;
            this.setActivity({ kind: 'sit', until: 0, arrived: false });
            this.world.walker.sitAt({ at: seat.at, yaw: seat.yaw });
          } else key = seat ? 'follow_decline' : 'sit_no';
          break;
        }
        case 'dance':
          if (this.npc.sceneId === 'noir_club') {
            key = 'dance_ok'; delta = 1;
            this.setActivity({ kind: 'dance', until: 0, arrived: false });
            this.world.walker.stop();
          } else key = 'dance_no';
          break;
        case 'help': key = 'help'; break;
        case 'about_self':
          if (det.fact && this.relations.learn(rel, det.fact)) { key = 'about_self'; extra.fact = det.fact; delta = 1; }
          else key = 'unknown';
          break;
        case 'yes': key = 'yes'; break;
        case 'no': key = 'no'; break;
        case 'question': key = sour && this.rng() < 0.4 ? null : 'question'; break;
        default: key = sour && this.rng() < 0.4 ? null : (sour ? 'unknown_low' : 'unknown');
      }

      if (delta > 0) this.relations.bump(rel, delta * (1 + (stageBefore === 'stranger' ? 0 : this.p.loyal * 0.3)));
      this.relations.exchanged(rel);
      this.socialNeed = Math.max(0, this.socialNeed - 0.25);
      const stageAfter = stageOf(rel.affinity);
      if (stageAfter !== stageBefore && atLeast(stageAfter, 'known') && stageAfter !== 'grudge' && det.intent !== 'insult') {
        followUp = this.talk.say(`stage_up_${stageAfter}`, c.userId, this.slots(c.name, rel));
      }

      if (key) {
        const line = this.talk.say(key, c.userId, this.slots(c.name, rel, extra), { fallback: 'unknown' });
        if (line && this.speak(line)) claim(c.userId, this.npc.id);
      }
      if (followUp) {
        const text2 = followUp;
        setTimeout(() => this.speak(text2), 3_500);
      }
    } catch (err) {
      warn('social', 'falha ao responder', { err: String(err) });
    }
  }

  dispose(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.gestureTimer) clearTimeout(this.gestureTimer);
    if (this.activity.kind === 'gather') GATHERINGS.leave(this.activity.g, this.npc.id);
    for (const c of this.conversations.values()) if (c.pending) clearTimeout(c.pending.timer);
    this.conversations.clear();
    SOCIAL_PEERS.delete(this.npc.id);
  }

  async flush(): Promise<void> {
    await this.relations.flush();
  }
}
