import { useEffect, useMemo, useRef, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import { useSessionStore } from '../state/useSessionStore.js';
import { intentFromQuery, type WorldIntent } from '../network/session.js';
import type { ApiLive } from '../network/api.js';
import { WorldView } from './WorldView.js';
import { EnterScreen, savedToken } from './EnterScreen.js';
import { authSession } from '../network/authSession.js';
import { FeedView } from './FeedView.js';
import { ProfileView } from './ProfileView.js';
import { StoreView } from './StoreView.js';
import { RankingsView } from './RankingsView.js';
import { AvatarView } from './AvatarView.js';
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

type Tab = 'world' | 'feed' | 'store' | 'profile' | 'look' | 'rankings';

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
  /** Por que a porta de entrada reapareceu, quando ela reaparece sozinha. */
  const [aviso, setAviso] = useState<string | null>(null);
  /** Recado do mundo para o jogador: a porta que não abriu, e por quê. */
  const [recado, setRecado] = useState<string | null>(null);

  const connect = useAccountStore((s) => s.connect);
  const sessionKind = useSessionStore((s) => s.kind);

  useEffect(() => { connect(token); }, [connect, token]);

  // A sessão se renova sozinha; quando ela é adotada ou perdida, a casca é
  // quem precisa saber. Sem isto, a renovação trocaria o token no armazenamento
  // e o React continuaria segurando o antigo — que é justamente o que entra nas
  // salas.
  useEffect(() => authSession.subscribe((fresh) => {
    setToken(fresh);
    if (!fresh) setAviso('Sua sessão expirou. Escolha um personagem para voltar.');
  }), []);

  /**
   * De onde a viagem partiu. Uma ref, não estado: ela existe para DESFAZER uma
   * viagem que falhou, e um render a mais por causa disso não muda nada na
   * tela — mas ler `intent` na hora da falha leria o destino, não a origem, e
   * "voltar" devolveria o jogador exatamente à porta que não abriu.
   */
  const origem = useRef<WorldIntent>(props.intent);

  /** Trocar de sala: o World remonta porque a chave muda. */
  const navigate = (next: WorldIntent) => {
    setRecado(null);
    setIntent((atual) => {
      origem.current = atual;
      return next;
    });
    setTab('world');
  };

  /**
   * A porta não abriu.
   *
   * Antes isto era invisível: falhar ao abrir o apartamento derrubava a
   * conexão, o World nascia sem cena declarada e desenhava a praça — o jogador
   * clicava em "Meu apartamento" e reaparecia na praça, sem uma palavra. Agora
   * a viagem é DESFEITA (volta-se para de onde se partiu) e o motivo é dito.
   */
  const viagemFalhou = (motivo: string) => {
    setRecado(motivo);
    const volta = origem.current;
    // Voltar para uma viagem é voltar para outra que também pode falhar; a
    // praça é o único destino que o mundo sabe desenhar sem servidor nenhum.
    setIntent(volta.kind === 'city' || volta.kind === 'offline'
      ? volta
      : { kind: 'city', sceneId: 'central_plaza' });
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
        aviso={aviso}
        onEnter={(fresh) => {
          setAviso(null);
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
        onOpenProfile={openProfile}
        onSessionLost={() => { authSession.esquecer(); }}
        onFailed={viagemFalhou}
        onTravel={(portal) => navigate(
          // `home` não é uma cena: é uma pergunta que só a API responde, e a
          // resposta muda de pessoa para pessoa. As outras são cenas públicas
          // e viram uma CityRoom.
          portal.to === 'home'
            ? { kind: 'apartment', apartmentId: 'me' }
            : { kind: 'city', sceneId: portal.to },
        )}
      />

      {tab === 'feed' && (
        <FeedView
          onWatch={watch}
          onOpenProfile={(id) => openProfile(id)}
          onGoLive={() => setGoLiveOpen(true)}
          onOpenRankings={() => setTab('rankings')}
        />
      )}

      {tab === 'store' && <StoreView />}

      {/* O placar não é uma aba do rodapé: cinco lugares já estão ocupados, e
          quem procura "quem está ganhando" chega pela tela de descoberta, que
          é o feed. */}
      {tab === 'rankings' && (
        <RankingsView onOpenProfile={openProfile} onClose={() => setTab('feed')} />
      )}

      {/* O criador não é uma aba do rodapé: chega-se a ele pelo perfil, que é
          onde alguém vai procurar o próprio visual. */}
      {tab === 'look' && <AvatarView onClose={() => setTab('profile')} />}

      {tab === 'profile' && (
        <ProfileView
          userId={profileTarget}
          onVisitApartment={(apartmentId) => navigate({ kind: 'apartment', apartmentId })}
          onWatchLive={(roomId) => navigate({ kind: 'watch', roomId })}
          onEditLook={() => setTab('look')}
          onLeave={() => {
            // Revoga a família do refresh no servidor e avisa os ouvintes —
            // que é quem devolve esta casca à porta de entrada.
            void authSession.logout();
            setAviso(null);
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

      {recado && tab === 'world' && (
        <p className="worldToast" role="alert" onClick={() => setRecado(null)}>{recado}</p>
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
