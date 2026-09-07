import { defaultApiGateway, type ApiGateway } from '../api/ApiGateway.js';

/**
 * O que só o game server vê (PRD §32).
 *
 * A North Star do produto conta quem teve interação social na semana, e quatro
 * das oito interações não existem em tabela nenhuma: **chat** (que não é
 * persistido de propósito — mensagem de sala não é patrimônio), **transmitir**,
 * **PK** e **visitar** um apartamento. Sem isto, a métrica principal do produto
 * enxergaria só metade do mundo, e a metade que ela enxergaria é justamente a
 * que envolve dinheiro.
 *
 * ## Por que um acumulador, e não uma chamada por evento
 *
 * A API guarda uma linha por pessoa/dia/tipo. Mandar uma requisição por
 * mensagem de chat seria pagar tráfego e latência para escrever a MESMA linha
 * mil vezes. Aqui o processo lembra o que já mandou e só reporta a novidade —
 * numa praça cheia conversando por uma hora, isso é uma chamada por pessoa.
 *
 * O esquecimento é proposital e vem com o dia: à meia-noite (do fuso do
 * jogador, que é quem a API usa para cortar o dia) o conjunto zera e a mesma
 * pessoa volta a ser reportada. Um processo que ficasse semanas no ar sem
 * esquecer nada acabaria com a métrica do dia seguinte.
 */

export type SocialKind = 'live' | 'chat' | 'pk' | 'visit';

/** Fuso do corte do dia; o mesmo que a API usa (`RANKINGS_TIMEZONE`). */
const TIMEZONE = process.env.SOCIAL_TIMEZONE || 'America/Sao_Paulo';

const diaDe = (agora: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, dateStyle: 'short' }).format(new Date(agora));

export interface SocialSignalsOptions {
  sink?: Pick<ApiGateway, 'reportSocial'>;
  now?: () => number;
  /** Janela de acúmulo. Curta o bastante para não perder tudo num restart. */
  flushMs?: number;
  autoFlush?: boolean;
}

export class SocialSignals {
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly autoFlush: boolean;
  private sinkInstance: Pick<ApiGateway, 'reportSocial'> | null;

  /** `userId:kind` já reportados HOJE. */
  private reportados = new Set<string>();
  /** O que ainda não foi mandado. */
  private pendentes = new Map<string, { userId: string; kind: SocialKind }>();
  private dia: string;
  private timer: NodeJS.Timeout | null = null;
  private enviando = false;

  constructor(options: SocialSignalsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.flushMs = options.flushMs ?? 30_000;
    this.autoFlush = options.autoFlush ?? true;
    this.sinkInstance = options.sink ?? null;
    this.dia = diaDe(this.now());
  }

  private get sink(): Pick<ApiGateway, 'reportSocial'> {
    if (!this.sinkInstance) this.sinkInstance = defaultApiGateway();
    return this.sinkInstance;
  }

  /** Alguém fez algo social. Barato o bastante para o caminho quente do chat. */
  mark(userId: string, kind: SocialKind): void {
    if (!userId) return;
    const hoje = diaDe(this.now());
    if (hoje !== this.dia) {
      // Virou o dia: tudo volta a ser novidade.
      this.dia = hoje;
      this.reportados.clear();
    }
    const chave = `${userId}:${kind}`;
    if (this.reportados.has(chave) || this.pendentes.has(chave)) return;
    this.pendentes.set(chave, { userId, kind });
    if (this.autoFlush) this.agendar();
  }

  private agendar(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.enviando || this.pendentes.size === 0) return;
    const lote = [...this.pendentes.values()];
    this.enviando = true;
    try {
      await this.sink.reportSocial(lote);
      // Só marca como reportado depois do sucesso: um lote perdido volta na
      // próxima janela em vez de sumir da métrica.
      for (const item of lote) {
        this.reportados.add(`${item.userId}:${item.kind}`);
        this.pendentes.delete(`${item.userId}:${item.kind}`);
      }
    } catch {
      // Fica pendente; a próxima janela tenta de novo.
    } finally {
      this.enviando = false;
      if (this.pendentes.size > 0 && this.autoFlush) this.agendar();
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Só para teste: o que está esperando envio. */
  get pending(): number { return this.pendentes.size; }
}

let singleton: SocialSignals | null = null;

/** Acumulador do processo. Preguiçoso: importar não abre timer. */
export function socialSignals(): SocialSignals {
  if (!singleton) singleton = new SocialSignals();
  return singleton;
}
