import { useEffect, useState } from 'react';
import { useAccountStore } from '../state/useAccountStore.js';
import { prazoCurto, restante, useEventStore } from '../state/useEventStore.js';
import type { CityEvent, EventStanding } from '../network/api.js';
import { short } from '../state/format.js';
import { Button } from './primitives/Controls.js';
import { IconClose } from './Icons.js';
import './events.css';

/**
 * Eventos da cidade (PRD §22 e §28).
 *
 * A tela inteira é leitura, e pela mesma razão do placar (§23): quem está
 * ganhando é a pergunta mais disputada do produto, e ter duas respostas — a do
 * banco e a do navegador — seria a pior falha possível nela. Nem a colocação,
 * nem o prêmio, nem a unidade do número são calculados aqui; até "entregas" e
 * "Creator Points" vêm escritos do servidor.
 *
 * A ÚNICA coisa derivada é o relógio, e ele é derivado do carimbo da resposta
 * (ver `restante`), não de um contador local.
 *
 * ## Sem retrato 3D, e de propósito
 *
 * O pódio do §23 desenha bustos porque são três pessoas e a tela é sobre elas.
 * Aqui podem ser dez colocados em três eventos ao mesmo tempo — trinta renders
 * na mesma fila do `PosterStudio` que serve a loja e o feed. O evento é sobre a
 * DISPUTA, não sobre os rostos; a inicial basta e o orçamento fica de pé.
 */

export interface EventsViewProps {
  onOpenProfile: (userId: string) => void;
  onClose: () => void;
}

export function EventsView({ onOpenProfile, onClose }: EventsViewProps) {
  const api = useAccountStore((s) => s.api);
  const meId = useAccountStore((s) => s.userId);
  const board = useEventStore((s) => s.board);
  const at = useEventStore((s) => s.at);
  const loading = useEventStore((s) => s.loading);
  const error = useEventStore((s) => s.error);
  const load = useEventStore((s) => s.load);

  // Força a releitura ao ABRIR a tela: quem veio aqui de propósito quer o
  // número de agora, não o de trinta segundos atrás que serve à faixa do feed.
  useEffect(() => { void load(api, true); }, [api, load]);

  // Um tique por minuto só para o prazo andar. Segundo a segundo seria um
  // render por segundo por um texto que diz "2 d 4 h".
  const [, redesenha] = useState(0);
  useEffect(() => {
    const t = setInterval(() => redesenha((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const vazio = board
    && board.running.length === 0 && board.upcoming.length === 0 && board.recent.length === 0;

  return (
    <section className="screen evt">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Eventos</h1>
          <p className="screen__sub">
            {board && board.pendingCredits > 0
              ? `Você está no pódio de algo: ${short(board.pendingCredits)} Credits se acabar assim`
              : 'A cidade inteira disputando a mesma coisa, com prazo'}
          </p>
        </div>
        <Button variant="ghost" icon={<IconClose size={14} />} onClick={onClose}>Fechar</Button>
      </header>

      {error && <p className="screen__hint">Não deu para carregar os eventos: {error}</p>}
      {!error && !board && loading && <p className="screen__hint">Carregando…</p>}

      {vazio && (
        <div className="evt__empty">
          <strong>Nenhum evento marcado.</strong>
          <p>Quando a cidade organizar uma disputa, ela aparece aqui — com prazo e prêmio.</p>
        </div>
      )}

      {board?.running.map((e) => (
        <EventCard key={e.id} event={e} at={at} meId={meId} onOpenProfile={onOpenProfile} />
      ))}

      {board && board.upcoming.length > 0 && (
        <>
          <h2 className="evt__section">A caminho</h2>
          {board.upcoming.map((e) => (
            <EventCard key={e.id} event={e} at={at} meId={meId} onOpenProfile={onOpenProfile} />
          ))}
        </>
      )}

      {board && board.recent.length > 0 && (
        <>
          <h2 className="evt__section">Encerrados</h2>
          {board.recent.map((e) => (
            <EventCard key={e.id} event={e} at={at} meId={meId} onOpenProfile={onOpenProfile} />
          ))}
        </>
      )}
    </section>
  );
}

function EventCard(
  { event, at, meId, onOpenProfile }:
  { event: CityEvent; at: number; meId: string | null; onOpenProfile: (id: string) => void },
) {
  const falta = restante(event.msLeft, at);
  const total = event.podium.reduce((a, b) => a + b, 0);

  /**
   * Quem está fora do top mostrado ganha a própria linha embaixo da lista.
   *
   * Sem isto, alguém em 41º abre a tela, não se encontra em lugar nenhum e
   * conclui que não está participando — quando está, e a dois pontos do pódio.
   */
  const foraDaLista = event.you
    && !event.standings.some((s) => s.userId === event.you?.userId);

  return (
    <article className={`evt__card is-${event.phase}`}>
      <header className="evt__head">
        <div className="evt__ident">
          <span className="evt__chip">{rotulo(event)}</span>
          <h3 className="evt__title">{event.title}</h3>
          <p className="evt__flavor">{event.flavor}</p>
        </div>
        <div className="evt__clock">
          <strong>{event.phase === 'settled' ? 'Encerrado' : prazoCurto(falta)}</strong>
          <small>{event.phase === 'upcoming' ? 'até começar' : event.phase === 'running' ? 'restantes' : ''}</small>
        </div>
      </header>

      <p className="evt__rule">
        <strong>{event.metricLabel}</strong> · {event.hint}
      </p>

      <div className="evt__meta">
        <span><strong>{short(total)}</strong> Credits em prêmios</span>
        <span><strong>{event.podium.length}</strong> colocações</span>
        <span><strong>{short(event.participants)}</strong> na disputa</span>
      </div>

      {event.phase === 'upcoming' && (
        <p className="evt__hint">
          Começa em {prazoCurto(falta)}. O que contar antes disso não entra no placar.
        </p>
      )}

      {event.phase !== 'upcoming' && event.standings.length === 0 && (
        <p className="evt__hint">
          Ninguém marcou {event.minScore} {event.unit} ainda. O primeiro a marcar lidera.
        </p>
      )}

      {event.standings.length > 0 && (
        <ol className="evt__list">
          {event.standings.map((s) => (
            <Linha key={s.userId} s={s} unit={event.unit} isSelf={s.userId === meId}
              onClick={() => onOpenProfile(s.userId)} />
          ))}
        </ol>
      )}

      {foraDaLista && event.you && (
        <ol className="evt__list evt__list--you">
          <Linha s={event.you} unit={event.unit} isSelf onClick={() => onOpenProfile(event.you!.userId)} />
        </ol>
      )}
    </article>
  );
}

function Linha(
  { s, unit, isSelf, onClick }:
  { s: EventStanding; unit: string; isSelf: boolean; onClick: () => void },
) {
  return (
    <li>
      <button type="button" className={`evt__row${isSelf ? ' is-self' : ''}`} onClick={onClick}>
        <span className={`evt__pos${s.rank <= 3 ? ` is-p${s.rank}` : ''}`}>{s.rank}</span>
        <span className="evt__mono" aria-hidden>{(s.displayName.trim()[0] ?? '?').toUpperCase()}</span>
        <span className="evt__who">
          <strong>{s.displayName}</strong>
          <small>{short(s.score)} {unit}</small>
        </span>
        {s.credits > 0 && (
          <span className={`evt__prize${s.awarded ? ' is-paid' : ''}`}>
            {short(s.credits)}
            <small>{s.awarded ? 'pagos' : 'Credits'}</small>
          </span>
        )}
      </button>
    </li>
  );
}

/** O selo do canto: o estado do evento em uma palavra. */
function rotulo(e: CityEvent): string {
  if (e.phase === 'running') return 'No ar';
  if (e.phase === 'upcoming') return 'Marcado';
  return 'Resultado';
}
