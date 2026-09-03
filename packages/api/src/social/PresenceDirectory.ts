import { config } from '../config.ts';

/**
 * Diretório de presença (SPECs §17).
 *
 * Junta os retratos que cada processo de game server manda e responde a única
 * pergunta que o mundo shardado tornou difícil: **em qual sala está fulano
 * agora?**
 *
 * Fica na memória da API, não no Postgres, e isso é uma decisão e não um
 * atalho:
 *
 *   - presença não sobrevive a uma queda por definição — se o game server
 *     morre, ninguém está em sala nenhuma, e uma linha no banco dizendo o
 *     contrário seria uma mentira durável;
 *   - a taxa de escrita é a de gente entrando e saindo de sala, que é alta e
 *     completamente descartável;
 *   - e a API é o lugar certo para juntar: ela é uma só, os game servers são
 *     muitos, e cada um só enxerga os próprios sockets.
 *
 * O preço é que reiniciar a API zera o mapa. O batimento dos game servers o
 * reconstrói em segundos, e é por isso que o protocolo é retrato inteiro em vez
 * de delta.
 *
 * ## Duas leituras, dois públicos
 *
 * `statusOf` é grosso e público: "está no mundo", "assistindo". Cabe no perfil
 * de qualquer um.
 *
 * `locationOf` devolve o SHARD. Isso é endereço, não status — quem tem o
 * roomId chega na pessoa. Esta classe não decide quem pode; ela só não deixa a
 * distinção se perder, e quem chama é responsável por exigir amizade antes de
 * entregar localização (a rota de amigos chega na tarefa 5).
 */

export type PresenceKind = 'in_world' | 'watching_live' | 'streaming' | 'in_pk';

const KINDS = new Set<PresenceKind>(['in_world', 'watching_live', 'streaming', 'in_pk']);

export function isPresenceKind(value: unknown): value is PresenceKind {
  return typeof value === 'string' && KINDS.has(value as PresenceKind);
}

export interface PresenceEntry {
  userId: string;
  sceneId: string;
  roomId: string;
  kind: PresenceKind;
  since: number;
}

export interface PresenceSnapshot {
  serverId: string;
  at: number;
  entries: PresenceEntry[];
}

export interface PresenceRecord extends PresenceEntry {
  /** Qual processo respondeu por este jogador, e quando falou pela última vez. */
  serverId: string;
  at: number;
}

export class PresenceDirectory {
  private readonly byUser = new Map<string, PresenceRecord>();
  /** Última vez que cada processo deu notícia. Fatia vencida vira offline. */
  private readonly servers = new Map<string, number>();

  private readonly ttlMs: number;
  private readonly now: () => number;

  // Sem parameter properties: a API roda .ts direto no Node, que só apaga
  // tipos — açúcar de TypeScript que gera código não passa aqui.
  constructor(ttlMs: number = config.presenceTtlMs, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * Recebe o retrato COMPLETO de um processo e substitui a fatia dele.
   *
   * Substituir é o ponto todo: quem sumiu do retrato saiu da sala, sem
   * ninguém precisar avisar. Um "saiu" perdido no meio do caminho se conserta
   * no retrato seguinte, o que um protocolo de deltas não consegue fazer.
   */
  ingest(snapshot: PresenceSnapshot): number {
    const at = this.now();
    this.servers.set(snapshot.serverId, at);

    const seen = new Set<string>();
    for (const entry of snapshot.entries) {
      const current = this.byUser.get(entry.userId);
      // Jogador que migrou de processo: o retrato ATRASADO do servidor antigo
      // ainda o lista, porque foi TIRADO antes de ele sair. Não pode desfazer o
      // registro do servidor que o recebeu.
      //
      // O critério é `since` — quando a pessoa chegou naquela sala —, e não a
      // hora de chegada da mensagem: quem chega atrasado chega, por definição,
      // depois. Comparar `since` entre processos cruza dois relógios, o que só
      // é aceitável porque a diferença em disputa é de segundos e o erro se
      // conserta sozinho no batimento seguinte; comparar hora de chegada não
      // seria aceitável nunca, porque erra SEMPRE.
      if (current && current.serverId !== snapshot.serverId && entry.since < current.since) continue;
      seen.add(entry.userId);
      this.byUser.set(entry.userId, { ...entry, serverId: snapshot.serverId, at });
    }

    for (const [userId, record] of this.byUser) {
      if (record.serverId !== snapshot.serverId) continue;
      if (seen.has(userId)) continue;
      this.byUser.delete(userId);
    }

    this.sweep();
    return seen.size;
  }

  /** Endereço exato — cena e shard. Null quando não está em sala nenhuma. */
  locationOf(userId: string): PresenceRecord | null {
    const record = this.byUser.get(userId);
    if (!record || !this.isFresh(record)) return null;
    return record;
  }

  /**
   * Estado grosso, sem endereço. `null` = offline (ausência de registro é a
   * representação de offline; ver PresenceKind).
   */
  statusOf(userId: string): PresenceKind | null {
    return this.locationOf(userId)?.kind ?? null;
  }

  statusesOf(userIds: readonly string[]): Map<string, PresenceKind> {
    const out = new Map<string, PresenceKind>();
    for (const id of userIds) {
      const kind = this.statusOf(id);
      if (kind) out.set(id, kind);
    }
    return out;
  }

  /** Quantos jogadores estão em alguma sala agora. */
  get onlineCount(): number {
    let n = 0;
    for (const record of this.byUser.values()) if (this.isFresh(record)) n++;
    return n;
  }

  /** Só para teste e diagnóstico. */
  reset(): void {
    this.byUser.clear();
    this.servers.clear();
  }

  /**
   * Um processo que parou de falar está morto, e todo mundo que ele declarava
   * caiu junto. É isso que impede um game server derrubado de deixar meia
   * cidade eternamente "online" — e é por isso que o batimento existe do outro
   * lado.
   */
  private isFresh(record: PresenceRecord): boolean {
    const lastSeen = this.servers.get(record.serverId) ?? 0;
    return this.now() - lastSeen <= this.ttlMs;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [serverId, at] of this.servers) {
      if (at >= cutoff) continue;
      this.servers.delete(serverId);
      for (const [userId, record] of this.byUser) {
        if (record.serverId === serverId) this.byUser.delete(userId);
      }
    }
  }
}

/** Diretório do processo da API. */
export const presenceDirectory = new PresenceDirectory();
