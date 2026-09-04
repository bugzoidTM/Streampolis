import { useEffect } from 'react';
import { useSocialStore } from '../state/useSocialStore.js';
import { presenceLabel } from '../state/format.js';
import type { Friend } from '../network/api.js';
import { usePoster } from './usePoster.js';
import { Button } from './primitives/Controls.js';
import { IconClose, IconUser } from './Icons.js';
import './friends.css';

/**
 * Amigos (PRD §20).
 *
 * Três listas na mesma tela, nesta ordem, e a ordem é o produto:
 *
 * 1. **Convites recebidos** primeiro, porque é a única coisa aqui que espera
 *    uma decisão sua. Enterrá-los embaixo de trinta amigos é como não ter o
 *    convite.
 * 2. **Amigos**, com os ONLINE no topo (quem ordena é o servidor) e o botão
 *    "Encontrar" na linha de quem está no mundo. É o motivo de a tela existir:
 *    uma lista de amigos que só mostra nomes é uma agenda telefônica.
 * 3. **Convites enviados**, por último e sem botão de destaque — é lembrete,
 *    não tarefa.
 *
 * "Encontrar" não é a mesma coisa que "visitar perfil": ele leva o corpo do
 * jogador para a sala onde a pessoa está AGORA (o shard, não a cena — ver
 * `session.ts`). Quem resolve o endereço é a casca, porque é ela que navega.
 */

export interface FriendsViewProps {
  onOpenProfile: (userId: string) => void;
  /** Ir até onde a pessoa está. A casca pede o endereço à API e viaja. */
  onMeet: (friend: Friend) => void;
  onClose: () => void;
}

/** De quanto em quanto tempo a lista relê quem está online. */
const RECARGA_MS = 15_000;

export function FriendsView({ onOpenProfile, onMeet, onClose }: FriendsViewProps) {
  const { friends, incoming, outgoing, state, error } = useSocialStore();
  const load = useSocialStore((s) => s.load);

  useEffect(() => {
    void load();
    // Presença envelhece sozinha: alguém entra na praça e nada nesta tela
    // acontece. O intervalo vive com o componente, então ele só corre com a
    // tela aberta.
    const timer = setInterval(() => void load(), RECARGA_MS);
    return () => clearInterval(timer);
  }, [load]);

  const vazio = friends.length === 0 && incoming.length === 0 && outgoing.length === 0;

  return (
    <section className="screen friends">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Amigos</h1>
          <p className="screen__sub">
            Amizade é nos dois sentidos: ela abre o seu apartamento fechado e
            deixa vocês se encontrarem na cidade.
          </p>
        </div>
        <Button variant="ghost" icon={<IconClose size={16} />} onClick={onClose}>Fechar</Button>
      </header>

      {state === 'loading' && vazio && <p className="screen__hint">Carregando…</p>}
      {error && <p className="screen__hint" role="alert">{error}</p>}

      {incoming.length > 0 && (
        <Secao titulo="Convites recebidos" contagem={incoming.length}>
          {incoming.map((f) => (
            <Linha key={f.userId} friend={f} onOpenProfile={onOpenProfile} onMeet={onMeet} />
          ))}
        </Secao>
      )}

      {friends.length > 0 && (
        <Secao titulo="Seus amigos" contagem={friends.length}>
          {friends.map((f) => (
            <Linha key={f.userId} friend={f} onOpenProfile={onOpenProfile} onMeet={onMeet} />
          ))}
        </Secao>
      )}

      {outgoing.length > 0 && (
        <Secao titulo="Convites enviados" contagem={outgoing.length}>
          {outgoing.map((f) => (
            <Linha key={f.userId} friend={f} onOpenProfile={onOpenProfile} onMeet={onMeet} />
          ))}
        </Secao>
      )}

      {vazio && state !== 'loading' && (
        <div className="friends__empty">
          <IconUser size={26} />
          <p>
            Você ainda não tem amigos aqui. Ande pela praça, abra o perfil de
            alguém e mande um convite — quando a pessoa aceitar, vocês aparecem
            um para o outro nesta lista.
          </p>
        </div>
      )}
    </section>
  );
}

function Secao(
  { titulo, contagem, children }: { titulo: string; contagem: number; children: React.ReactNode },
) {
  return (
    <div className="friends__section">
      <h2 className="friends__sectionTitle">
        {titulo} <span className="friends__count sp-num">{contagem}</span>
      </h2>
      <ul className="friends__list">{children}</ul>
    </div>
  );
}

function Linha(
  { friend, onOpenProfile, onMeet }:
  { friend: Friend; onOpenProfile: (id: string) => void; onMeet: (f: Friend) => void },
) {
  const accept = useSocialStore((s) => s.accept);
  const decline = useSocialStore((s) => s.decline);
  const remove = useSocialStore((s) => s.remove);
  const busy = useSocialStore((s) => s.busy) === friend.userId;
  const poster = usePoster(friend.avatar, { shot: 'bust', at: 1.6, width: 96, height: 96 });

  return (
    <li className="friends__row">
      <button
        type="button"
        className="friends__who"
        onClick={() => onOpenProfile(friend.userId)}
      >
        <span className={`friends__face${friend.online ? ' is-online' : ''}`}>
          {poster ? <img src={poster} alt="" /> : <span className="friends__faceSkeleton" />}
        </span>
        <span className="friends__id">
          <strong className="friends__name">{friend.displayName}</strong>
          <small className={friend.online ? 'is-online' : undefined}>
            {friend.online ? presenceLabel(friend.presence) : 'Offline'}
            {friend.agency ? ` · ${friend.agency}` : ''}
          </small>
        </span>
      </button>

      <div className="friends__actions">
        {friend.state === 'incoming' && (
          <>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void accept(friend.userId)}>
              Aceitar
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decline(friend.userId)}>
              Recusar
            </Button>
          </>
        )}

        {friend.state === 'friends' && (
          <>
            {/* Só para quem está no mundo: "Encontrar" alguém offline levaria a
                uma sala onde não há ninguém. */}
            {friend.online && (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onMeet(friend)}>
                Encontrar
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(friend.userId)}>
              Desfazer
            </Button>
          </>
        )}

        {friend.state === 'outgoing' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(friend.userId)}>
            Cancelar
          </Button>
        )}
      </div>
    </li>
  );
}
