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
  const everyone = useRoomStore((s) => s.people);
  // Pessoas primeiro, personagens depois — e o NÚMERO do cabeçalho conta só
  // gente (PRD §25: personagem nunca é apresentado como jogador). Com trinta
  // personagens na praça, "31 por perto" seria uma mentira sobre a cidade.
  const people = everyone.filter((p) => !p.npc);
  const characters = everyone.filter((p) => p.npc);
  const [showCharacters, setShowCharacters] = useState(false);
  // Aberta no computador, recolhida no telefone. `matchMedia` uma vez, no
  // primeiro render: isto é uma preferência inicial, não um layout responsivo
  // — quem recolher a lista numa tela larga quer que ela fique recolhida.
  const [open, setOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 900px)').matches,
  );

  // Sozinho na sala não há "quem está aqui": o painel só apareceria para
  // informar que não há ninguém, o que é pior do que não aparecer. Personagens
  // não contam como companhia para esta decisão, mas contam para o painel
  // existir: uma praça com gente da cidade merece a lista.
  if (hidden || (people.length < 2 && characters.length === 0)) return null;

  return (
    <aside className={`roster${open ? ' is-open' : ''}`} aria-label="Quem está aqui">
      <button type="button" className="roster__head" onClick={() => setOpen(!open)}>
        <span className="roster__dot" aria-hidden />
        <strong>{people.length}</strong>
        <span className="roster__title">por perto{characters.length > 0 && <small className="roster__npcs"> · {characters.length} personagens</small>}</span>
        <span className="roster__chev" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <ul className="roster__list">
          {people.map((p) => <Row key={p.sessionId} p={p} onOpenProfile={onOpenProfile} />)}
          {characters.length > 0 && (
            <li className="roster__group">
              <button type="button" className="roster__grouphead" onClick={() => setShowCharacters(!showCharacters)}>
                <span>Personagens da cidade ({characters.length})</span>
                <span className="roster__chev" aria-hidden>{showCharacters ? '▾' : '▸'}</span>
              </button>
            </li>
          )}
          {showCharacters && characters.map((p) => <Row key={p.sessionId} p={p} onOpenProfile={onOpenProfile} />)}
        </ul>
      )}
    </aside>
  );
}

function Row({ p, onOpenProfile }: { p: RoomPerson; onOpenProfile: (userId: string) => void }) {
  return (
    <li>
      <button
        type="button"
        className={`roster__row${p.isSelf ? ' is-self' : ''}${p.npc ? ' is-npc' : ''}`}
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
  );
}

function legenda(p: RoomPerson): string {
  // Antes de qualquer papel: um personagem da cidade nunca passa por jogador
  // (PRD §25), nem quando é o dono de uma sala.
  if (p.npc) return 'Personagem da cidade (NPC)';
  if (p.role === 'host') return 'Transmitindo';
  if (p.role === 'cohost') return 'No palco';
  if (p.role === 'owner') return 'Dono da casa';
  return p.agency ?? 'Independente';
}
