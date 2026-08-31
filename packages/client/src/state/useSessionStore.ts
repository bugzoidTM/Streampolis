import { create } from 'zustand';
import type { AnyWorldConnection } from '../network/WorldConnection.js';
import type { IntentKind } from '../network/session.js';

/**
 * A sessão atual: em que sala este cliente está e por qual conexão fala.
 *
 * Existe porque a UI precisa MANDAR coisas — uma mensagem, uma curtida, um
 * presente — e ela não tem acesso ao World. A conexão é criada uma vez pela
 * camada de sessão e fica aqui; nenhum componente abre sala nenhuma.
 *
 * Nada de estado de jogo mora aqui: quem tem saldo, placar ou lista de
 * jogadores é o servidor, e o que chega dele passa pela ponte (network/bridge).
 */

export type SessionStatus = 'connecting' | 'online' | 'offline' | 'failed';

interface SessionState {
  connection: AnyWorldConnection | null;
  status: SessionStatus;
  kind: IntentKind;
  /** Mensagem curta em pt-BR quando algo falha; nula quando está tudo bem. */
  error: string | null;
  /** Quem eu sou nesta sala, segundo o servidor. */
  me: { userId: string; sessionId: string; name: string } | null;

  attach: (connection: AnyWorldConnection, kind: IntentKind) => void;
  goOffline: (kind: IntentKind) => void;
  fail: (error: string) => void;
  detach: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  connection: null,
  status: 'connecting',
  kind: 'offline',
  error: null,
  me: null,

  attach: (connection, kind) => {
    const player = connection.localPlayer;
    set({
      connection,
      kind,
      status: 'online',
      error: null,
      me: {
        userId: player?.id ?? '',
        sessionId: connection.sessionId,
        // Espectador de live não tem corpo na sala e, portanto, não tem entrada
        // em `players`: o nome só aparece quando ele sobe ao palco.
        name: player?.name ?? '',
      },
    });
  },

  goOffline: (kind) => set({ connection: null, kind, status: 'offline', error: null, me: null }),
  fail: (error) => set({ status: 'failed', error }),
  detach: () => set({ connection: null, status: 'offline', me: null }),
}));

/** Atalho para quem só quer mandar algo e não se importa com o resto. */
export function activeConnection(): AnyWorldConnection | null {
  return useSessionStore.getState().connection;
}
