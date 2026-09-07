import { create } from 'zustand';
import type { GigBoard, GigRun } from '../network/api.js';

/**
 * O bico em andamento, do lado da tela.
 *
 * Existe uma store para isto — e não um `useState` no painel — porque três
 * lugares diferentes precisam da MESMA corrida ao mesmo tempo: o painel de
 * bicos (a lista e o botão), a faixa do HUD (a parada da vez e o relógio) e o
 * mundo 3D (o pilar de luz na parada). Com estado local, abrir o painel seria
 * condição para o marcador aparecer.
 *
 * ## Ela não calcula nada
 *
 * Nem pagamento, nem nível de atenção, nem se a parada foi cumprida. Tudo isso
 * chega pronto: da API na abertura (`GET /me/gigs`) e da sala a cada chegada
 * (`MSG.gigUpdate`), que por sua vez traz o que a API apurou. Uma tela que soma
 * Credits é uma segunda economia, e é a regra 6 do §68 sendo quebrada pelo
 * lugar mais fácil de quebrar.
 *
 * A ÚNICA coisa derivada aqui é o tempo restante, e ela é derivada na leitura a
 * partir do prazo que veio do servidor — não guardada num contador que anda
 * sozinho. Um contador local diverge do prazo real na primeira aba em segundo
 * plano, quando o navegador estrangula o `setInterval`.
 */

interface GigState {
  board: GigBoard | null;
  run: GigRun | null;
  /** O último pagamento recebido, para a tela comemorar uma vez e esquecer. */
  paid: { credits: number; at: number } | null;
  setBoard: (board: GigBoard | null) => void;
  setRun: (run: GigRun | null) => void;
  markPaid: (credits: number) => void;
  clearPaid: () => void;
  clear: () => void;
}

export const useGigStore = create<GigState>((set) => ({
  board: null,
  run: null,
  paid: null,
  setBoard: (board) => set({ board, run: board?.active ?? null }),
  setRun: (run) => set((s) => ({
    run,
    // O quadro guarda a corrida em `active`, e duas cópias que discordam são
    // duas verdades: a lista mostraria "em andamento" depois da entrega.
    board: s.board ? { ...s.board, active: run } : s.board,
  })),
  markPaid: (credits) => set({ paid: { credits, at: Date.now() } }),
  clearPaid: () => set({ paid: null }),
  clear: () => set({ board: null, run: null, paid: null }),
}));

/** Segundos que faltam para o prazo. Negativo quando já venceu. */
export function gigSecondsLeft(run: GigRun | null): number {
  if (!run) return 0;
  return Math.round((new Date(run.deadlineAt).getTime() - Date.now()) / 1000);
}
