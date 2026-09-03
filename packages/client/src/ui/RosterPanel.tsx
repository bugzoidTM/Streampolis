import { useState } from 'react';
import { useRoomStore, type RoomPerson } from '../state/useRoomStore.js';
import { GifterBadge } from './primitives/Controls.js';
import './roster.css';

/**
 * Quem está aqui (PRD §6).
 *
 * A praça existe para "encontrar jogadores... ver perfis, seguir", e até agora
 * a única forma de saber quem estava por perto era virar a câmera e ler as
 * placas sobre as cabeças — o que funciona para quem está a cinco metros e
 * falha para todo o resto de uma praça de 26 m de raio.
 *
 * Duas decisões:
 *
 * - **É uma lista de PESSOAS, não um placar.** Cada linha abre o perfil, que é
 *   de onde se segue alguém. O caminho social do produto começa aqui.
 * - **Recolhida por padrão no telefone, aberta no computador.** A tela grande
 *   tem canto sobrando e um jogo social quer mostrar que há gente; a pequena
 *   não tem, e uma lista permanente cobriria o mundo.
 *
 * Ela NÃO conta espectadores de live: numa live quem manda no número é o
 * `viewers` do estado da sala, que conta quem está assistindo sem corpo em
 * cena. Contar corpos ali daria um número menor e diferente do que o painel da
 * live mostra — dois números para a mesma pergunta.
 */

export interface RosterPanelProps {
  onOpenProfile: (userId: string) => void;
  hidden?: boolean;
}

export function RosterPanel({ onOpenProfile, hidden }: RosterPanelProps) {
  const people = useRoomStore((s) => s.people);
  // Aberta no computador, recolhida no telefone. `matchMedia` uma vez, no
  // primeiro render: isto é uma preferência inicial, não um layout responsivo
  // — quem recolher a lista numa tela larga quer que ela fique recolhida.
  const [open, setOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 900px)').matches,
  );

  // Sozinho na sala não há "quem está aqui": o painel só apareceria para
  // informar que não há ninguém, o que é pior do que não aparecer.
  if (hidden || people.length < 2) return null;

  return (
    <aside className={`roster${open ? ' is-open' : ''}`} aria-label="Quem está aqui">
      <button type="button" className="roster__head" onClick={() => setOpen(!open)}>
        <span className="roster__dot" aria-hidden />
        <strong>{people.length}</strong>
        <span className="roster__title">por perto</span>
        <span className="roster__chev" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <ul className="roster__list">
          {people.map((p) => (
            <li key={p.sessionId}>
              <button
                type="button"
                className={`roster__row${p.isSelf ? ' is-self' : ''}`}
                onClick={() => onOpenProfile(p.userId)}
              >
                <span className="roster__mono" aria-hidden>{(p.name.trim()[0] ?? '?').toUpperCase()}</span>
                <span className="roster__who">
                  <span className="roster__name">{p.name}{p.isSelf && ' (você)'}</span>
                  <small>{legenda(p)}</small>
                </span>
                {p.gifterLevel > 0 && <GifterBadge xp={p.gifterXp} compact />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function legenda(p: RoomPerson): string {
  if (p.role === 'host') return 'Transmitindo';
  if (p.role === 'cohost') return 'No palco';
  if (p.role === 'owner') return 'Dono da casa';
  return p.agency ?? 'Independente';
}
