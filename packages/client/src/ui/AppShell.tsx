import { useEffect, useMemo, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import { useSessionStore } from '../state/useSessionStore.js';
import { intentFromQuery, type WorldIntent } from '../network/session.js';
import type { ApiLive } from '../network/api.js';
import { WorldView } from './WorldView.js';
import { EnterScreen, clearToken, saveToken, savedToken } from './EnterScreen.js';
import { FeedView } from './FeedView.js';
import { ProfileView } from './ProfileView.js';
import { StoreView } from './StoreView.js';
import { IconBag, IconClose, IconFlame, IconPlus, IconUser } from './Icons.js';
import { Button } from './primitives/Controls.js';
import './screens.css';

/**
 * A casca do produto: mundo 3D embaixo, telas por cima, navegação no rodapé.
 *
 * A decisão que organiza tudo: o mundo NUNCA desmonta ao trocar de aba. Abrir o
 * feed não derruba a sala nem recria o contexto WebGL — ele só pausa. O que
 * remonta o mundo é mudar de INTENÇÃO (entrar numa live, visitar um
 * apartamento), e aí a troca é proposital.
 *
 * Por isso a navegação tem duas naturezas: `setTab` é interface, `navigate` é
 * viagem. Um card do feed navega; a aba Loja não.
 */

type Tab = 'world' | 'feed' | 'store' | 'profile';

export interface AppShellProps {
  intent: WorldIntent;
  token?: string;
  tier?: 'low' | 'medium' | 'high';
  displayName?: string;
  avatar?: AvatarConfig;
  endpoint?: string;
}

export function AppShell(props: AppShellProps) {
  // O token pode vir da URL (link direto, ferramenta de captura) ou da última
  // visita. Sem nenhum dos dois, a primeira tela é a porta de entrada.
  const [token, setToken] = useState<string | undefined>(() => props.token ?? savedToken());
  const [tab, setTab] = useState<Tab>('world');
  const [intent, setIntent] = useState<WorldIntent>(props.intent);
  const [profileTarget, setProfileTarget] = useState<string | null>(null);
  const [goLiveOpen, setGoLiveOpen] = useState(false);

  const connect = useAccountStore((s) => s.connect);
  const sessionKind = useSessionStore((s) => s.kind);

  useEffect(() => { connect(token); }, [connect, token]);

  /** Trocar de sala: o World remonta porque a chave muda. */
  const navigate = (next: WorldIntent) => {
    setIntent(next);
    setTab('world');
  };

  const openProfile = (userId: string | null) => {
    setProfileTarget(userId);
    setTab('profile');
  };

  const watch = (live: Pick<ApiLive, 'roomId'>) => navigate({ kind: 'watch', roomId: live.roomId });

  const key = useMemo(() => intentKey(intent), [intent]);
  const hosting = sessionKind === 'golive';

  if (!token) {
    return (
      <EnterScreen
        onEnter={(fresh) => {
          saveToken(fresh);
          setToken(fresh);
          // A intenção foi calculada quando ainda não havia token, e sem token
          // ela só pode ser "offline". Agora que há, ela é recalculada com as
          // mesmas regras da URL — senão quem acabou de escolher um personagem
          // entra num mundo sem servidor, sozinho, sem nenhum aviso.
          setIntent(intentFromQuery(new URLSearchParams(location.search), true));
        }}
      />
    );
  }

  return (
    <>
      <WorldView
        key={key}
        intent={intent}
        token={token}
        tier={props.tier}
        displayName={props.displayName}
        avatar={props.avatar}
        endpoint={props.endpoint}
        paused={tab !== 'world'}
      />

      {tab === 'feed' && (
        <FeedView
          onWatch={watch}
          onOpenProfile={(id) => openProfile(id)}
          onGoLive={() => setGoLiveOpen(true)}
        />
      )}

      {tab === 'store' && <StoreView />}

      {tab === 'profile' && (
        <ProfileView
          userId={profileTarget}
          onVisitApartment={(apartmentId) => navigate({ kind: 'apartment', apartmentId })}
          onWatchLive={(roomId) => navigate({ kind: 'watch', roomId })}
          onEditLook={() => { location.search = '?view=lab'; }}
          onLeave={() => {
            clearToken();
            setToken(undefined);
          }}
        />
      )}

      {goLiveOpen && (
        <GoLiveSheet
          onClose={() => setGoLiveOpen(false)}
          onStart={(title, category) => {
            setGoLiveOpen(false);
            navigate({ kind: 'golive', title, category, sceneId: 'live_room' });
          }}
        />
      )}

      <nav className="nav" aria-label="Navegação principal">
        <NavButton label="Mundo" active={tab === 'world'} onClick={() => setTab('world')}>
          <IconFlame size={20} />
        </NavButton>
        <NavButton label="Lives" active={tab === 'feed'} onClick={() => setTab('feed')}>
          <IconEyeGlyph />
        </NavButton>

        <button
          type="button"
          className={`nav__go${hosting ? ' is-live' : ''}`}
          onClick={() => (hosting ? setTab('world') : setGoLiveOpen(true))}
          aria-label={hosting ? 'Voltar para a sua live' : 'Abrir uma live'}
        >
          {hosting ? <span className="nav__goDot" /> : <IconPlus size={22} />}
          <span className="nav__goLabel">{hosting ? 'AO VIVO' : 'Go Live'}</span>
        </button>

        <NavButton label="Loja" active={tab === 'store'} onClick={() => setTab('store')}>
          <IconBag size={20} />
        </NavButton>
        <NavButton label="Perfil" active={tab === 'profile'} onClick={() => openProfile(null)}>
          <IconUser size={20} />
        </NavButton>
      </nav>
    </>
  );
}

function NavButton(
  { label, active, onClick, children }:
  { label: string; active: boolean; onClick: () => void; children: React.ReactNode },
) {
  return (
    <button
      type="button"
      className={`nav__item${active ? ' is-on' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {children}
      <span className="nav__label">{label}</span>
    </button>
  );
}

/** Ícone do feed: um olho cheio, para não repetir o traço do HUD da live. */
function IconEyeGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"
        stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}

function GoLiveSheet({ onClose, onStart }: { onClose: () => void; onStart: (t: string, c: string) => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Bate-papo');
  const categories = ['Bate-papo', 'Música', 'Dança', 'Jogos', 'Beleza', 'PK'];

  return (
    <div className="sheet" role="dialog" aria-label="Abrir live">
      <form
        className="sheet__box"
        onSubmit={(e) => { e.preventDefault(); onStart(title.trim() || 'Minha live', category); }}
      >
        <header className="sheet__head">
          <strong>Abrir live</strong>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Fechar">
            <IconClose size={16} />
          </button>
        </header>

        <label className="sheet__label" htmlFor="live-title">Sobre o que é a sua live?</label>
        <input
          id="live-title"
          className="sheet__input"
          value={title}
          maxLength={80}
          placeholder="Noite de PK 💜"
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="sheet__chips">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={`sheet__chip${category === c ? ' is-on' : ''}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>

        <p className="sheet__note">
          Você entra no estúdio e a live aparece no feed. Quem manda presente
          paga de verdade — a cobrança é do servidor.
        </p>
        <Button variant="live" size="lg" block type="submit">Entrar ao vivo</Button>
      </form>
    </div>
  );
}

/** Chave de remontagem: muda quando a SALA muda, não quando a aba muda. */
function intentKey(intent: WorldIntent): string {
  switch (intent.kind) {
    case 'city': return `city:${intent.sceneId}`;
    case 'offline': return `offline:${intent.sceneId}`;
    case 'apartment': return `apt:${intent.apartmentId}`;
    case 'watch': return `watch:${intent.roomId}`;
    case 'golive': return `live:${intent.title}:${intent.category}`;
  }
}
