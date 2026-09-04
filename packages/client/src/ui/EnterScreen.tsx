import { useEffect, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { ApiClient, ApiError, type DemoAccount } from '../network/api.js';
import { authSession } from '../network/authSession.js';
import { usePoster } from './usePoster.js';
import { Button } from './primitives/Controls.js';
import './enter.css';

/**
 * Porta de entrada.
 *
 * Duas portas, e a ordem entre elas importa: **conta própria primeiro**,
 * personagem de demonstração depois. Enquanto não havia cadastro, escolher um
 * personagem era a única entrada — uma porta aberta, declarada como tal, que a
 * API só oferece fora de produção. Agora ela é o atalho para dar uma olhada, e
 * quem quiser guardar o que fez cria uma conta.
 *
 * As contas de demonstração continuam sumindo sozinhas onde `dev-login` não
 * existe: em produção esta tela mostra só o formulário, sem nenhuma alteração
 * no código.
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

      <ContaForm api={api} onEnter={onEnter} />

      {accounts === null && <p className="enter__hint">Carregando personagens…</p>}

      {accounts !== null && accounts.length > 0 && (
        <p className="enter__hint enter__or">ou dê uma olhada com um personagem pronto</p>
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
        Os personagens prontos são contas de teste e a carteira deles é de
        mentira. Nada aqui cobra dinheiro de verdade.
      </footer>
    </main>
  );
}

/**
 * Entrar ou criar conta, no mesmo formulário.
 *
 * Um formulário só, com um interruptor, porque os campos são quase os mesmos e
 * porque a pessoa que erra de aba não sabe que errou — ela só vê "não foi
 * possível entrar". O e-mail aparece apenas no cadastro: pedi-lo para entrar
 * seria pedir um dado que o login não usa.
 *
 * Nada aqui valida senha por conta própria além do tamanho mínimo. Quem recusa
 * "senha igual ao seu nome" é a API, com a frase pronta — duas listas de regras
 * de senha, uma em cada lado, divergem no primeiro dia.
 */
function ContaForm({ api, onEnter }: { api: ApiClient; onEnter: (token: string) => void }) {
  const [modo, setModo] = useState<'entrar' | 'criar'>('entrar');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const criando = modo === 'criar';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErro(null);
    try {
      const session = criando
        ? await api.register(username.trim(), email.trim(), password)
        : await api.login(username.trim(), password);
      // O par inteiro: sem o refresh, esta sessão duraria 15 minutos.
      authSession.adopt(session);
      onEnter(session.token);
    } catch (err) {
      // A API escreve a frase para o jogador ler ("Este nome já está em uso");
      // traduzir status aqui perderia isso.
      setErro(err instanceof ApiError ? err.message : 'Não foi possível concluir agora.');
      setBusy(false);
    }
  };

  return (
    <form className="enter__form" onSubmit={submit}>
      <div className="enter__tabs" role="tablist" aria-label="Entrar ou criar conta">
        <button
          type="button" role="tab" aria-selected={!criando}
          className={`enter__tab${!criando ? ' is-on' : ''}`}
          onClick={() => { setModo('entrar'); setErro(null); }}
        >
          Entrar
        </button>
        <button
          type="button" role="tab" aria-selected={criando}
          className={`enter__tab${criando ? ' is-on' : ''}`}
          onClick={() => { setModo('criar'); setErro(null); }}
        >
          Criar conta
        </button>
      </div>

      <label className="enter__label" htmlFor="conta-username">Nome de usuário</label>
      <input
        id="conta-username"
        className="enter__input"
        value={username}
        autoComplete="username"
        maxLength={24}
        placeholder="seu_nome"
        onChange={(e) => setUsername(e.target.value)}
      />

      {criando && (
        <>
          <label className="enter__label" htmlFor="conta-email">E-mail</label>
          <input
            id="conta-email"
            className="enter__input"
            type="email"
            value={email}
            autoComplete="email"
            maxLength={160}
            placeholder="voce@exemplo.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </>
      )}

      <label className="enter__label" htmlFor="conta-senha">Senha</label>
      <input
        id="conta-senha"
        className="enter__input"
        type="password"
        value={password}
        autoComplete={criando ? 'new-password' : 'current-password'}
        maxLength={200}
        placeholder={criando ? 'pelo menos 8 caracteres' : ''}
        onChange={(e) => setPassword(e.target.value)}
      />

      {erro && <p className="enter__error" role="alert">{erro}</p>}

      <Button
        variant="primary" size="lg" block type="submit"
        disabled={busy || username.trim().length < 3 || password.length < 8 || (criando && !email.includes('@'))}
      >
        {busy ? 'Um instante…' : criando ? 'Criar conta e entrar' : 'Entrar'}
      </Button>
    </form>
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
