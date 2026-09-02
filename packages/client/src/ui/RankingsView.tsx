import { useEffect, useState } from 'react';
import { useAccountStore } from '../state/useAccountStore.js';
import type { RankingBoard, RankingEntry, RankingPage, RankingRange } from '../network/api.js';
import { short } from '../state/format.js';
import { usePoster } from './usePoster.js';
import { Button, Segmented } from './primitives/Controls.js';
import { IconClose } from './Icons.js';
import './rankings.css';

/**
 * Rankings (PRD §23).
 *
 * A tela inteira é leitura: ela escolhe o placar e a janela, e desenha o que
 * voltou NA ORDEM em que voltou. Nenhuma linha é reordenada, somada ou
 * completada aqui — quem está ganhando é a pergunta mais disputada do produto,
 * e ter duas respostas (a do banco e a do navegador) seria a pior das falhas
 * possíveis nela. Até a unidade do número ("Coins enviados", "Vitórias") vem
 * escrita do servidor.
 *
 * O pódio existe por um motivo além do enfeite: o retrato 3D custa quatro
 * arquivos e um render, e vinte deles de uma vez travam a fila do
 * `PosterStudio` — que é a mesma que desenha a loja e o feed. Os três primeiros
 * ganham rosto; do quarto em diante a linha é compacta, com a inicial. É onde
 * o olho vai, e é o que cabe no orçamento.
 */

export interface RankingsViewProps {
  onOpenProfile: (userId: string) => void;
  onClose: () => void;
}

const BOARDS: Array<{ id: RankingBoard; label: string }> = [
  { id: 'streamers', label: 'Streamers' },
  { id: 'gifters', label: 'Gifters' },
  { id: 'pk', label: 'PK' },
];

const RANGES: Array<{ id: RankingRange; label: string }> = [
  { id: 'today', label: 'Hoje' },
  { id: 'week', label: 'Semana' },
  { id: 'season', label: 'Temporada' },
];

const VAZIO: Record<RankingBoard, string> = {
  streamers: 'Ninguém recebeu presentes nesta janela ainda.',
  gifters: 'Ninguém presenteou nesta janela ainda.',
  pk: 'Nenhum PK terminou nesta janela ainda.',
};

export function RankingsView({ onOpenProfile, onClose }: RankingsViewProps) {
  const api = useAccountStore((s) => s.api);
  const meId = useAccountStore((s) => s.userId);
  const [board, setBoard] = useState<RankingBoard>('streamers');
  const [range, setRange] = useState<RankingRange>('season');
  const [page, setPage] = useState<RankingPage | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let vivo = true;
    // A troca de aba não pode mostrar o placar anterior com o título novo: por
    // um instante a tela diria "Gifters" acima das linhas de "Streamers".
    setPage(null);
    setErro(null);
    api.rankings(board, range)
      .then((r) => { if (vivo) setPage(r); })
      .catch((e: Error) => { if (vivo) setErro(e.message); });
    return () => { vivo = false; };
  }, [api, board, range]);

  const podio = page?.entries.slice(0, 3) ?? [];
  const resto = page?.entries.slice(3) ?? [];

  return (
    <section className="screen rank">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Placar</h1>
          <p className="screen__sub">{legenda(page, range)}</p>
        </div>
        <Button variant="ghost" icon={<IconClose size={14} />} onClick={onClose}>Fechar</Button>
      </header>

      <Segmented value={board} onChange={setBoard} options={BOARDS} ariaLabel="Placar" />
      <Segmented value={range} onChange={setRange} options={RANGES} size="sm" ariaLabel="Janela" />

      {erro && <p className="screen__hint">Não deu para carregar o placar: {erro}</p>}
      {!erro && !page && <p className="screen__hint">Carregando…</p>}

      {page && page.entries.length === 0 && (
        <div className="rank__empty">
          <strong>Placar aberto.</strong>
          <p>{VAZIO[board]}</p>
        </div>
      )}

      {podio.length > 0 && (
        <ol className="rank__podium">
          {podio.map((e) => (
            <PodiumCard
              key={e.userId} entry={e} unit={page?.unit ?? ''} isSelf={e.userId === meId}
              onClick={() => onOpenProfile(e.userId)}
            />
          ))}
        </ol>
      )}

      {resto.length > 0 && (
        <ol className="rank__list">
          {resto.map((e) => (
            <li key={e.userId}>
              <button
                type="button"
                className={`rank__row${e.userId === meId ? ' is-self' : ''}`}
                onClick={() => onOpenProfile(e.userId)}
              >
                <span className="rank__pos">{e.rank}</span>
                <span className="rank__mono" aria-hidden>{inicial(e.displayName)}</span>
                <span className="rank__who">
                  <strong>{e.displayName}</strong>
                  <small>{e.agency ?? 'Independente'}</small>
                </span>
                <span className="rank__value">{short(e.value)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * A linha embaixo do título: de quando é este placar.
 *
 * Um número sem janela não quer dizer nada — 872 Coins "de sempre" e "de hoje"
 * contam histórias opostas. Na temporada entra o nome dela e quanto falta para
 * acabar, que é a informação que faz alguém voltar amanhã.
 */
function legenda(page: RankingPage | null, range: RankingRange): string {
  if (!page) return 'Quem está ganhando em Streampolis';
  if (range === 'season') {
    if (!page.season) return 'Entre temporadas — o próximo placar começa em breve';
    const dias = Math.max(0, Math.ceil((new Date(page.season.endsAt).getTime() - Date.now()) / 86_400_000));
    return `${page.season.name} · ${page.unit} · termina em ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
  }
  return `${range === 'today' ? 'Hoje' : 'Esta semana'} · ${page.unit}`;
}

function inicial(nome: string): string {
  return (nome.trim()[0] ?? '?').toUpperCase();
}

function PodiumCard(
  { entry, unit, isSelf, onClick }:
  { entry: RankingEntry; unit: string; isSelf: boolean; onClick: () => void },
) {
  // Busto, como o card do feed: é a mesma pessoa e o mesmo estúdio, então o
  // cache do `PosterStudio` serve as duas telas com um render só.
  const poster = usePoster(entry.avatar, { shot: 'bust', at: 1.2, width: 180, height: 200 });
  return (
    <li className={`rank__podium-item is-p${entry.rank}${isSelf ? ' is-self' : ''}`}>
      <button type="button" className="rank__podium-btn" onClick={onClick}>
        <span className="rank__medal">{entry.rank}</span>
        <span className="rank__art">
          {poster ? <img src={poster} alt="" /> : <span className="rank__skeleton" aria-hidden />}
        </span>
        <strong className="rank__name">{entry.displayName}</strong>
        <small className="rank__agency">{entry.agency ?? 'Independente'}</small>
        <span className="rank__score">
          {short(entry.value)}
          <small>{unit}</small>
        </span>
      </button>
    </li>
  );
}
