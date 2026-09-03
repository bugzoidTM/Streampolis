import { useCallback, useEffect, useState } from 'react';
import type { AnimState } from '@streampolis/shared';
import { activeConnection } from '../state/useSessionStore.js';
import type { World } from '../game/World.js';
import {
  IconCelebrate, IconClap, IconDance, IconSit, IconStop, IconWave,
} from './Icons.js';
import './emote.css';

/**
 * Gestos (PRD §6: "encontrar jogadores, conversar").
 *
 * Isto não implementa nada novo no servidor — implementa o que já estava lá e
 * ninguém podia alcançar. `BaseWorldRoom` aceita seis gestos, tem tempo de
 * recarga, recusa gesto de quem está andando e propaga o resultado no estado da
 * sala; os clipes existem, medidos, desde a leva de animação. Só faltava um
 * caminho da mão do jogador até `connection.emote()` — e sem ele um mundo
 * multiplayer tinha exatamente uma forma de se expressar: texto.
 *
 * Três decisões:
 *
 * - **Teclas 1 a 6.** É um jogo de computador; num jogo de computador gesto é
 *   tecla. O botão continua existindo para o toque e para quem não decorou.
 * - **O gesto vai como INTENÇÃO e volta como estado.** A animação que o jogador
 *   vê é a mesma que os outros veem, pelo mesmo caminho — o servidor põe
 *   `player.anim` e o mundo desenha o que chegou. Tocar a animação localmente
 *   "para não esperar" é como se cria um jogador que dança sozinho na própria
 *   tela.
 * - **Andar cancela.** O servidor recusa gesto de quem se move, e a barra diz
 *   isso em vez de engolir o clique: um botão que não faz nada e não explica
 *   parece um jogo quebrado.
 */

export interface EmoteBarProps {
  world: World | null;
  hidden?: boolean;
}

interface Gesto {
  anim: AnimState;
  label: string;
  Icone: (props: { size?: number }) => JSX.Element;
}

/**
 * Os seis que o servidor aceita (`EMOTABLE`), nesta ordem.
 *
 * `idle` é o primeiro e chama-se "Parar": sentar e dançar continuam até o
 * jogador andar, então sair do gesto precisa ser tão fácil quanto entrar —
 * sem isso a única saída é dar um passo, que é o oposto de "quero ficar aqui
 * parado".
 */
const GESTOS: Gesto[] = [
  { anim: 'idle', label: 'Parar', Icone: IconStop },
  { anim: 'wave', label: 'Acenar', Icone: IconWave },
  { anim: 'clap', label: 'Palmas', Icone: IconClap },
  { anim: 'dance', label: 'Dançar', Icone: IconDance },
  { anim: 'celebrate', label: 'Comemorar', Icone: IconCelebrate },
  { anim: 'sit', label: 'Sentar', Icone: IconSit },
];

/** O mesmo tempo de recarga do servidor, para o botão não mentir. */
const RECARGA_MS = 900;

export function EmoteBar({ world, hidden }: EmoteBarProps) {
  const [travado, setTravado] = useState(false);
  const [andando, setAndando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  // O servidor recusa gesto de quem anda, então a barra precisa saber se o
  // corpo está em movimento. Uma vez por segundo e meio bastaria; 4 Hz é o
  // suficiente para o botão não ficar apagado depois de o jogador parar.
  useEffect(() => {
    if (!world || hidden) return;
    const id = window.setInterval(() => setAndando(world.localMoving), 250);
    return () => window.clearInterval(id);
  }, [world, hidden]);

  const enviar = useCallback((anim: AnimState) => {
    const connection = activeConnection();
    if (!connection) {
      setAviso('Sem servidor — gestos precisam de sala.');
      return;
    }
    if (world?.localMoving && anim !== 'idle') {
      setAviso('Pare de andar para fazer um gesto.');
      return;
    }
    connection.emote(anim);
    setAviso(null);
    setTravado(true);
    window.setTimeout(() => setTravado(false), RECARGA_MS);
  }, [world]);

  useEffect(() => {
    if (aviso === null) return;
    const id = window.setTimeout(() => setAviso(null), 2_200);
    return () => window.clearTimeout(id);
  }, [aviso]);

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      // Nunca enquanto se escreve: "1" é um caractere antes de ser um atalho, e
      // roubá-lo de um campo de texto é o clássico "o jogo comeu minha frase".
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const i = Number.parseInt(e.key, 10) - 1;
      const gesto = GESTOS[i];
      if (!gesto || !Number.isFinite(i)) return;
      e.preventDefault();
      enviar(gesto.anim);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, enviar]);

  if (hidden) return null;

  return (
    <div className="emotes" role="group" aria-label="Gestos">
      {aviso && <p className="emotes__aviso" role="status">{aviso}</p>}
      <div className="emotes__row">
        {GESTOS.map((g, i) => (
          <button
            key={g.anim}
            type="button"
            className="emotes__btn"
            // Andar cancela o gesto no servidor, e "Parar" continua valendo:
            // é como se volta do sentado sem dar um passo.
            disabled={travado || (andando && g.anim !== 'idle')}
            onClick={() => enviar(g.anim)}
            title={`${g.label} (${i + 1})`}
          >
            <g.Icone size={21} />
            <span className="emotes__tecla" aria-hidden>{i + 1}</span>
            <span className="emotes__label">{g.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
