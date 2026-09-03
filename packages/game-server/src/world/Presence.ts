import { config } from '../config.js';
import { defaultApiGateway, type ApiGateway } from '../api/ApiGateway.js';
import type { PresenceEntry, PresenceKind, PresenceSnapshot, SceneId } from '../shared.js';

/**
 * Quem está onde, dentro DESTE processo (SPECs §17).
 *
 * O game server é a única autoridade sobre presença — é ele que tem os sockets
 * abertos. Mas ele não é o lugar onde a presença é CONSULTADA: amanhã existem
 * dois processos de game server, e cada um só conhece os seus. Por isso aqui só
 * se acumula o retrato, e a API é quem junta os retratos de todo mundo.
 *
 * O que sai daqui é sempre o retrato inteiro, nunca "fulano entrou". Ver
 * PresenceSnapshot para o porquê.
 */

export interface EnterInput {
  userId: string;
  sceneId: SceneId;
  roomId: string;
  kind: PresenceKind;
}

export interface PresenceSink {
  publishPresence(snapshot: PresenceSnapshot): Promise<void>;
}

export interface TrackerOptions {
  serverId?: string;
  sink?: PresenceSink;
  now?: () => number;
  /** Espera antes de publicar, para juntar entradas/saídas na mesma rajada. */
  flushDelayMs?: number;
  /** Reenvio periódico. Mantém a fatia deste servidor fresca na API. */
  heartbeatMs?: number;
  /** Falso nos testes: nada de timers, o flush é chamado à mão. */
  autoFlush?: boolean;
}

export class PresenceTracker {
  private readonly entries = new Map<string, PresenceEntry>();
  private readonly now: () => number;
  private readonly flushDelayMs: number;
  private readonly heartbeatMs: number;
  private readonly autoFlush: boolean;

  private pendingFlush: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private publishing = false;
  /** Alguém mexeu no mapa enquanto um envio estava no ar. */
  private dirtyWhilePublishing = false;
  /** Evita bater na API a cada 15 s num servidor que está vazio há horas. */
  private lastPublishedEmpty = true;
  private changes = 0;

  readonly serverId: string;

  constructor(private readonly options: TrackerOptions = {}) {
    this.serverId = options.serverId ?? config.serverId;
    this.now = options.now ?? Date.now;
    this.flushDelayMs = options.flushDelayMs ?? config.presenceFlushMs;
    this.heartbeatMs = options.heartbeatMs ?? config.presenceHeartbeatMs;
    this.autoFlush = options.autoFlush ?? true;
  }

  /** Só é construído no primeiro jogador: um servidor vazio não fala com a API. */
  private sinkInstance: PresenceSink | null = null;
  private get sink(): PresenceSink {
    if (!this.sinkInstance) this.sinkInstance = this.options.sink ?? (defaultApiGateway() as ApiGateway);
    return this.sinkInstance;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Quantas vezes o mapa mudou de verdade. As salas reanunciam presença a cada
   * evento, então o que separa "mudou" de "repetiu" precisa ser observável —
   * é este número que garante que o reanúncio é de graça.
   */
  get revision(): number {
    return this.changes;
  }

  locationOf(userId: string): PresenceEntry | undefined {
    return this.entries.get(userId);
  }

  /**
   * Entrou numa sala — ou continua na mesma e mudou de papel (subiu ao palco,
   * começou um PK). Idempotente de propósito: as salas chamam isto sempre que
   * algo muda, e repetir o mesmo estado não pode gerar publicação.
   */
  enter(input: EnterInput): void {
    const previous = this.entries.get(input.userId);
    const sameRoom = previous?.roomId === input.roomId;
    if (sameRoom && previous.kind === input.kind && previous.sceneId === input.sceneId) return;

    this.entries.set(input.userId, {
      userId: input.userId,
      sceneId: input.sceneId,
      roomId: input.roomId,
      kind: input.kind,
      // Trocar de papel dentro da mesma sala não é chegar de novo: quem está no
      // palco há vinte minutos continua ali desde que entrou.
      since: sameRoom ? previous.since : this.now(),
    });
    this.touch();
  }

  /**
   * Saiu de uma sala ESPECÍFICA.
   *
   * O roomId não é decoração: atravessar um portal produz o `enter` da sala
   * nova antes do `leave` da sala velha (o cliente entra e só então a antiga
   * percebe a queda do socket). Sem conferir de qual sala é a saída, o portal
   * apagaria a presença recém-criada e o jogador sumiria do mapa justamente
   * enquanto anda.
   */
  leave(userId: string, roomId: string): void {
    const current = this.entries.get(userId);
    if (!current || current.roomId !== roomId) return;
    this.entries.delete(userId);
    this.touch();
  }

  /** A sala morreu. Ninguém que estava nela continua em lugar nenhum. */
  dropRoom(roomId: string): void {
    let changed = false;
    for (const [userId, entry] of this.entries) {
      if (entry.roomId !== roomId) continue;
      this.entries.delete(userId);
      changed = true;
    }
    if (changed) this.touch();
  }

  snapshot(): PresenceSnapshot {
    return { serverId: this.serverId, at: this.now(), entries: [...this.entries.values()] };
  }

  /** Publica agora, sem esperar a janela de coalescência. */
  async flush(): Promise<void> {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (this.publishing) {
      this.dirtyWhilePublishing = true;
      return;
    }
    const snapshot = this.snapshot();
    if (snapshot.entries.length === 0 && this.lastPublishedEmpty && !this.dirtyWhilePublishing) {
      // Nada a dizer e nada mudou: servidor ocioso não precisa acordar a API.
      return;
    }
    this.publishing = true;
    this.dirtyWhilePublishing = false;
    try {
      await this.sink.publishPresence(snapshot);
      this.lastPublishedEmpty = snapshot.entries.length === 0;
    } catch {
      // Um retrato perdido se corrige sozinho no próximo: é por isso que o
      // protocolo é retrato e não delta. Nada de fila de reenvio aqui.
      this.lastPublishedEmpty = false;
    } finally {
      this.publishing = false;
      if (this.dirtyWhilePublishing) this.touch();
    }
  }

  /** Para os testes e para o desligamento: sem timers pendurados no processo. */
  stop(): void {
    if (this.pendingFlush) clearTimeout(this.pendingFlush);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.pendingFlush = null;
    this.heartbeat = null;
  }

  private touch(): void {
    this.changes++;
    if (!this.autoFlush) return;
    this.ensureHeartbeat();
    if (this.pendingFlush) return;
    // Uma sala que enche despeja dezenas de joins em milissegundos; a janela
    // transforma isso num POST só.
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      void this.flush();
    }, this.flushDelayMs);
    this.pendingFlush.unref?.();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    // A API expira por TTL a fatia de quem parou de falar. O batimento é o que
    // distingue "o servidor caiu" de "ninguém entrou nem saiu nos últimos 15 s".
    this.heartbeat = setInterval(() => void this.flush(), this.heartbeatMs);
    this.heartbeat.unref?.();
  }
}

let singleton: PresenceTracker | null = null;

/** Rastreador do processo. Preguiçoso: importar este módulo não abre timer. */
export function presence(): PresenceTracker {
  if (!singleton) singleton = new PresenceTracker();
  return singleton;
}
