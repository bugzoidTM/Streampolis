import { useEffect, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { ApiClient, type DemoAccount } from '../network/api.js';
import { authSession } from '../network/authSession.js';
import { usePoster } from './usePoster.js';
import { Button } from './primitives/Controls.js';
import './enter.css';

/**
 * Porta de entrada da demonstração.
 *
 * O jogo inteiro depende de um token assinado pela API, e não existe cadastro
 * ainda — então a versão pública entra por personagem. É uma porta aberta,
 * declarada como tal na tela: a API só oferece `dev-login` fora de produção, e
 * onde houver dinheiro de verdade essa rota não existe.
 *
 * Os retratos são renderizados de verdade, com a aparência que cada conta tem
 * no banco. Escolher um personagem é a primeira coisa que alguém faz aqui;
 * mostrar três bonecos iguais seria começar mentindo sobre o produto.
 */

export interface EnterScreenProps {
  onEnter: (token: string) => void;
  /**
   * Por que esta tela apareceu. Vazio na primeira visita; preenchido quando a
   * sessão acabou — quem foi devolvido para cá merece saber que não foi um
   * bug, e que basta entrar de novo.
   */
  aviso?: string | null;
}

export function EnterScreen({ onEnter, aviso }: EnterScreenProps) {
  const [api] = useState(() => new ApiClient(undefined));
  const [accounts, setAccounts] = useState<DemoAccount[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.demoAccounts().then((list) => { if (alive) setAccounts(list); });
    return () => { alive = false; };
  }, [api]);

  const enter = async (username: string) => {
    setBusy(username);
    setError(null);
    try {
      const session = await api.enterAs(username);
      // O par inteiro: sem o refresh, esta sessão duraria 15 minutos e
      // terminaria no mesmo "modo offline" de antes.
      authSession.adopt(session);
      onEnter(session.token);
    } catch {
      setError('Não foi possível entrar agora. Tente de novo em instantes.');
      setBusy(null);
    }
  };

  return (
    <main className="enter">
      <div className="enter__glow" aria-hidden />
      <header className="enter__head">
        <h1 className="enter__title">STREAMPOLIS</h1>
        <p className="enter__tag">
          Uma cidade de criadores. Ande por ela, abra a sua live, presenteie quem
          você gosta.
        </p>
      </header>

      {aviso && <p className="enter__error" role="status">{aviso}</p>}

      {accounts === null && <p className="enter__hint">Carregando personagens…</p>}

      {accounts !== null && accounts.length === 0 && (
        <div className="enter__fallback">
          <p className="enter__hint">
            Esta instância não oferece entrada por personagem. Abra com
            <code> ?token=SEU_TOKEN </code> para entrar.
          </p>
        </div>
      )}

      <div className="enter__cast">
        {(accounts ?? []).map((account) => (
          <CastCard
            key={account.username}
            account={account}
            busy={busy === account.username}
            disabled={busy !== null}
            onPick={() => void enter(account.username)}
          />
        ))}
      </div>

      {error && <p className="enter__error" role="alert">{error}</p>}

      <footer className="enter__foot">
        Demonstração pública: as contas são de teste e a carteira é de mentira.
        Nada aqui cobra dinheiro de verdade.
      </footer>
    </main>
  );
}

function CastCard(
  { account, busy, disabled, onPick }:
  { account: DemoAccount; busy: boolean; disabled: boolean; onPick: () => void },
) {
  const poster = usePoster(account.avatar as AvatarConfig | null, {
    shot: 'full', at: 1.7, width: 260, height: 360,
  });

  return (
    <button type="button" className="cast" onClick={onPick} disabled={disabled}>
      <span className="cast__art">
        {poster ? <img src={poster} alt="" /> : <span className="cast__skeleton" />}
      </span>
      <span className="cast__name">{account.displayName}</span>
      <span className="cast__cta">{busy ? 'Entrando…' : 'Jogar como'}</span>
    </button>
  );
}

/**
 * Onde o token da demonstração fica entre visitas.
 *
 * Quem guarda de verdade é o `authSession`, que também guarda o refresh e sabe
 * renovar. Estas três funções continuam existindo porque o resto da casca fala
 * nesses termos — mas nenhuma delas toca em `localStorage` por conta própria,
 * senão haveria dois donos do mesmo token.
 */
export const TOKEN_KEY = 'streampolis.token';

export function savedToken(): string | undefined {
  return authSession.token;
}

export function saveToken(_token: string): void {
  // No-op deliberado: `authSession.adopt()` já gravou o par ao entrar.
}

export function clearToken(): void {
  void authSession.logout();
}
