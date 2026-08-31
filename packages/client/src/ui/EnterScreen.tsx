import { useEffect, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { ApiClient, type DemoAccount } from '../network/api.js';
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
}

export function EnterScreen({ onEnter }: EnterScreenProps) {
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

/** Onde o token da demonstração fica entre visitas. */
export const TOKEN_KEY = 'streampolis.token';

export function savedToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    // Navegador com armazenamento bloqueado: a sessão dura só esta aba.
    return undefined;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch { /* sem persistência; segue em memória */ }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* nada a limpar */ }
}
