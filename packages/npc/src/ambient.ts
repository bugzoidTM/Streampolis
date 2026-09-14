import { isAddressed } from './brain.js';
import { log } from './log.js';
import { mulberry32, seedOf, type Mind } from './mind.js';
import type { AmbientProfile, AmbientStep } from './roster.js';
import { ahead, clearanceFor, nearestFree, sceneKnowledge } from './scenes.js';
import { freeSeatNear } from './seats.js';
import type { ChatMessage } from './shared.js';
import type { Nearby, World } from './world.js';

/**
 * Figurante com corpo de verdade: máquina de estados sobre um programa.
 *
 * Nada aqui é vontade. O programa diz "fique aqui 40–90 s, depois ande até
 * ali, depois sente", e a mente só cumpre e recomeça. O que faz um figurante
 * destes valer mais que os desenhados no cliente (`AmbientCrowd`) é que ele é
 * o MESMO para todo mundo, colide, tem nome na placa e se vira para quem o
 * chama — e o servidor sabe que ele existe.
 *
 * A única fala é de balcão: se o perfil traz `lines` e alguém o chama pelo
 * nome a até 6 m, ele diz uma delas (com intervalo longo). Sem `lines`, só se
 * vira para a pessoa por alguns segundos. Nada de conversa: figurante que
 * conversa é um personagem social, e essa é outra classe.
 */

const CALL_M = 6;
const LINE_GAP_MS = 60_000;
const LINE_PER_PERSON_MS = 180_000;
const TURN_MS = 5_000;

type Phase = 'going' | 'doing';

export class AmbientMind implements Mind {
  private readonly rng: () => number;
  private step = -1;
  private phase: Phase = 'going';
  private doneAt = 0;
  private lastLineAt = 0;
  private lineIndex = 0;
  private readonly lineAt = new Map<string, number>();
  private stuckSteps = 0;
  /** Prazo para CHEGAR ao que o passo pede; vencido, o programa segue. */
  private goingUntil = 0;

  constructor(
    readonly npc: { id: string; name: string; sceneId: World['sceneId'] },
    private world: World,
    private readonly profile: AmbientProfile,
  ) {
    this.rng = mulberry32(seedOf(npc.id));
  }

  rebind(world: World): void {
    this.world = world;
    this.step = -1;
    this.phase = 'going';
    this.doneAt = 0;
  }

  status(): Record<string, unknown> {
    const s = this.current();
    return { role: this.profile.role, step: this.step, phase: this.phase, doing: s?.do ?? null, pose: this.world.pose };
  }

  private current(): AmbientStep | null {
    return this.profile.program[this.step] ?? null;
  }

  private secs(range: [number, number] | undefined, fallback: [number, number] = [8, 20]): number {
    const [a, b] = range ?? fallback;
    return (a + this.rng() * Math.max(0, b - a)) * 1000;
  }

  // ------------------------------------------------------------- programa

  tick(): void {
    const me = this.world.position;
    if (!me || !this.profile.program.length) return;
    const walker = this.world.walker;
    if (walker.attending) return;
    const now = Date.now();
    const step = this.current();
    if (!step) { this.advance(me); return; }
    if (this.phase === 'going' && this.goingUntil && now > this.goingUntil) {
      log('ambient', 'não chegou a tempo; segue o programa', { npc: this.npc.name, step: this.step, do: step.do });
      this.advance(me);
      return;
    }

    if (step.do === 'stand') {
      const at = step.at;
      const d = Math.hypot(at.x - me.x, at.z - me.z);
      if (this.phase === 'going') {
        if (d <= 1.0) {
          this.phase = 'doing';
          this.doneAt = now + this.secs(step.secs, [30, 90]);
          if (typeof step.yaw === 'number') this.world.faceTo(ahead(me, step.yaw));
          this.world.pose = step.pose && step.pose !== 'idle' ? step.pose : null;
          walker.hold = step.pose === 'sit' ? 'seated' : this.world.pose ? 'gesture' : 'free';
        } else if (walker.idle && !walker.staying) {
          // A âncora do "fique aqui" só puxa de volta quem se afastou; para
          // chegar lá pela primeira vez é preciso mandar ir.
          walker.setTarget(at);
        } else if (walker.idle && d > 1.0) {
          this.stuck(me);
        }
        return;
      }
      if (now >= this.doneAt) this.advance(me);
      return;
    }

    if (step.do === 'walk') {
      if (this.phase === 'going') {
        if (walker.idle) {
          // A ordem de ir saiu em `advance`; parado agora é porque chegou (ou desistiu).
          const target = step.to ?? null;
          const arrived = target ? Math.hypot(target.x - me.x, target.z - me.z) <= 1.0 : true;
          if (arrived) {
            this.phase = 'doing';
            this.doneAt = now + this.secs(step.secs, [2, 8]);
          } else {
            this.stuck(me);
          }
        }
        return;
      }
      if (now >= this.doneAt) this.advance(me);
      return;
    }

    // sit
    if (this.phase === 'going') {
      if (walker.seated) {
        this.phase = 'doing';
        this.doneAt = now + this.secs(step.secs, [40, 120]);
        walker.hold = 'seated';
        return;
      }
      if (!walker.sitting) {
        if (this.doneAt === 0) {
          const seats = sceneKnowledge(this.npc.sceneId).seats;
          const near = step.near ?? me;
          const occupied = this.world.people().map((p) => ({ x: p.x, z: p.z }));
          const seat = freeSeatNear(seats, near, occupied) ?? freeSeatNear(seats, near, occupied);
          if (!seat) { this.advance(me); return; }
          walker.sitAt({ at: seat.at, yaw: seat.yaw });
          this.doneAt = 1;
        } else {
          // Desistiu no caminho (vaga ocupada no meio tempo, preso): segue o programa.
          this.stuck(me);
        }
      }
      return;
    }
    if (now >= this.doneAt) { walker.standUp(); this.advance(me); }
  }

  /** Um passo que não se completa não trava o programa: conta e segue. */
  private stuck(me: { x: number; z: number }): void {
    if (++this.stuckSteps > 60) log('ambient', 'passo abandonado', { npc: this.npc.name, step: this.step });
    else if (this.stuckSteps < 3) return;
    this.advance(me);
  }

  private advance(me: { x: number; z: number }): void {
    const walker = this.world.walker;
    walker.release();
    walker.hold = 'free';
    this.world.pose = null;
    this.stuckSteps = 0;
    this.phase = 'going';
    this.doneAt = 0;
    this.goingUntil = Date.now() + 120_000;
    this.step = (this.step + 1) % this.profile.program.length;
    const step = this.current();
    if (!step) return;
    if (step.do === 'stand') {
      const at = nearestFree(this.npc.sceneId, step.at, clearanceFor(step.pose));
      step.at = at;
      // `stayAt` para tudo o que era ordem; a ordem de ir tem de vir depois dela.
      walker.stayAt(at);
      if (Math.hypot(at.x - me.x, at.z - me.z) > 1.0) walker.setTarget(at);
    } else if (step.do === 'walk') {
      if (step.to) {
        step.to = nearestFree(this.npc.sceneId, step.to);
        walker.setTarget(step.to);
      } else {
        walker.pickDestination(me, this.rng);
      }
    }
  }

  // ---------------------------------------------------------------- fala

  onChat(msg: ChatMessage): void {
    if (msg.system || msg.npc || msg.senderId === this.npc.id) return;
    if (!isAddressed(msg.text, this.npc.name)) return;
    const who = this.world.people().find((p) => p.userId === msg.senderId);
    if (!who || who.distance > CALL_M) return;
    this.world.attend(msg.senderId, TURN_MS);
    const lines = this.profile.lines ?? [];
    if (!lines.length) return;
    const now = Date.now();
    if (now - this.lastLineAt < LINE_GAP_MS) return;
    if (now - (this.lineAt.get(msg.senderId) ?? 0) < LINE_PER_PERSON_MS) return;
    const line = lines[this.lineIndex++ % lines.length]!;
    if (this.world.say(line)) {
      this.lastLineAt = now;
      this.lineAt.set(msg.senderId, now);
    }
  }

  onAppeared(_p: Nearby): void {}
  onGone(_p: Nearby): void {}
  onNotice(_code: string, _text: string): void {}
  dispose(): void {}
}
