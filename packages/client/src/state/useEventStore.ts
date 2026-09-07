import { create } from 'zustand';
import type { ApiClient, EventsBoard } from '../network/api.js';

/**
 * O quadro de eventos, do lado da tela (PRD §22/§28).
 *
 * Uma store, e não um `useState` na tela de eventos, porque dois lugares muito
 * distantes precisam do mesmo quadro: a FAIXA no topo do feed (que é como
 * alguém descobre que existe um evento acontecendo) e a TELA de eventos. Com
 * estado local, abrir a faixa seria condição para a tela saber o que mostrar —
 * e a faixa buscaria de novo tudo o que a tela acabou de buscar.
 *
 * ## Ela não conta o tempo, e não soma prêmio
 *
 * O servidor manda `msLeft` no instante da resposta e o pódio já em Credits. O
 * relógio da tela desconta o tempo decorrido DESDE a resposta (ver
 * `restante`), em vez de guardar um contador que anda sozinho: um `setInterval`
 * estrangulado numa aba em segundo plano diverge do prazo real em minutos, e o
 * jogador voltaria para uma disputa que a tela jura que ainda está aberta.
 *
 * ## Cache curto, com um motivo
 *
 * 30 segundos. O placar de um evento muda quando alguém do outro lado da cidade
 * faz alguma coisa — não quando quem olha faz. Recarregar a cada abertura de
 * aba seria uma consulta pesada (é uma janela inteira de `gift_events`) por um
 * número que quase sempre veio igual; esperar mais do que isso faria a faixa
 * mentir sobre uma disputa que virou.
 */

const VALIDADE_MS = 30_000;

interface EventState {
  board: EventsBoard | null;
  /** Quando a resposta chegou. É o zero do relógio da tela. */
  at: number;
  loading: boolean;
  error: string | null;
  load: (api: ApiClient | null, force?: boolean) => Promise<void>;
  clear: () => void;
}

export const useEventStore = create<EventState>((set, get) => ({
  board: null,
  at: 0,
  loading: false,
  error: null,

  load: async (api, force = false) => {
    if (!api) return;
    const s = get();
    if (s.loading) return;
    if (!force && s.board && Date.now() - s.at < VALIDADE_MS) return;
    set({ loading: true });
    try {
      const board = await api.events();
      set({ board, at: Date.now(), loading: false, error: null });
    } catch (err) {
      // Evento é vitrine, não caminho crítico: o feed abre sem ele. O erro fica
      // guardado para a TELA dedicada dizer o que houve — a faixa some calada.
      set({ loading: false, error: (err as Error).message });
    }
  },

  clear: () => set({ board: null, at: 0, error: null }),
}));

/**
 * Quanto falta, agora.
 *
 * `msLeft` valia no instante `at`; o que passou desde então já foi. Derivar na
 * leitura é o que permite a mesma resposta servir a faixa e a tela sem que as
 * duas discordem do relógio.
 */
export function restante(msLeft: number, at: number): number {
  return Math.max(0, msLeft - (Date.now() - at));
}

/** "2 d 4 h", "3 h 12 min", "8 min". Nunca "0 dias". */
export function prazoCurto(ms: number): string {
  if (ms <= 0) return 'encerrado';
  const min = Math.floor(ms / 60_000);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d} d ${h % 24} h`;
  if (h >= 1) return `${h} h ${min % 60} min`;
  if (min >= 1) return `${min} min`;
  return 'menos de 1 min';
}
