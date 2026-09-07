import { useEffect } from 'react';
import { useAccountStore } from '../state/useAccountStore.js';
import { prazoCurto, restante, useEventStore } from '../state/useEventStore.js';
import { short } from '../state/format.js';
import './events.css';

/**
 * A faixa do evento, no topo do feed (PRD §22).
 *
 * Ela existe porque uma tela que ninguém abre não é um evento — é uma tabela.
 * O feed é onde alguém chega para descobrir o que está acontecendo, e um
 * evento com prazo é exatamente isso. A faixa some sozinha quando não há nada
 * no ar: um lugar permanentemente reservado para "nenhum evento" é pior do que
 * nenhum lugar.
 *
 * Mostra UM evento — o que acaba primeiro. Três faixas empilhadas empurrariam
 * as lives para fora da primeira tela, e a live é o produto.
 */

export interface EventBannerProps {
  onOpen: () => void;
}

export function EventBanner({ onOpen }: EventBannerProps) {
  const api = useAccountStore((s) => s.api);
  const board = useEventStore((s) => s.board);
  const at = useEventStore((s) => s.at);
  const load = useEventStore((s) => s.load);

  // Sem `force`: a faixa se contenta com o cache de 30 s da store. Quem quer o
  // número exato abre a tela, e é ela que força.
  useEffect(() => { void load(api); }, [api, load]);

  const evento = board?.running
    .slice()
    .sort((a, b) => a.msLeft - b.msLeft)[0];
  if (!evento) return null;

  const falta = restante(evento.msLeft, at);
  const eu = evento.you;

  return (
    <button type="button" className="evtbanner" onClick={onOpen}>
      <span className="evtbanner__pulse" aria-hidden />
      <span className="evtbanner__body">
        <strong className="evtbanner__title">{evento.title}</strong>
        <small className="evtbanner__sub">
          {eu
            ? `Você está em ${eu.rank}º com ${short(eu.score)} ${evento.unit}`
            : `${evento.metricLabel} · ${short(evento.participants)} na disputa`}
        </small>
      </span>
      <span className="evtbanner__clock">
        <strong>{prazoCurto(falta)}</strong>
        <small>restantes</small>
      </span>
    </button>
  );
}
