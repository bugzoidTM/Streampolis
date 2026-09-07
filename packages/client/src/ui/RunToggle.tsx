import { useCallback, useEffect, useState } from 'react';
import type { World } from '../game/World.js';
import { IconRun } from './Icons.js';
import './run.css';

/**
 * O botão de correr (PRD §34, "Novos bairros").
 *
 * Correr sempre existiu — `MoveIntent.run` está no protocolo desde o primeiro
 * dia, o servidor valida 5,2 m/s contra 2,4 m/s da caminhada, e o Shift já
 * mandava a intenção. O que não existia era **como descobrir isso**, e em
 * aparelho de toque não existia sequer o meio: o único jeito era empurrar o
 * direcional virtual até os últimos 15% do curso, que ninguém adivinha.
 *
 * Enquanto o mundo era uma praça de 30 m de raio isso passava. O Distrito
 * Sombra em duas ruas tem 116 m de avenida: atravessá-lo andando leva quase
 * cinquenta segundos, e um bico no nível de atenção 5 pede mais do que a
 * caminhada consegue dar (ver `gigs.ts`). A partir daí, uma tecla que ninguém
 * acha deixa de ser um detalhe de conforto e vira uma parte do jogo escondida.
 *
 * ## Trava, não gatilho
 *
 * Segurar Shift com a mão esquerda enquanto ela também dirige o WASD é a
 * postura que cansa em qualquer jogo, e no dedo não é nem possível. Então o
 * botão TRAVA, e o Shift passa a INVERTER: com a corrida ligada, segurá-lo faz
 * andar. É o "always run" de sempre, e é o que impede o defeito óbvio da
 * alternativa — travar a corrida e perder a caminhada, que numa cena onde se
 * conversa parado é exatamente o que não se quer.
 *
 * ## Ele não fala com a rede
 *
 * Escreve `world.input.alwaysRun` e nada mais. Quem transforma isso em
 * `MoveIntent.run` é o laço do `World`, e quem decide a velocidade é o
 * servidor (SPECs §21) — um botão de tela que mexesse em metros por segundo
 * seria a regra 1 do §68 quebrada pelo lugar mais fácil de quebrar.
 */

export interface RunToggleProps {
  world: World | null;
  hidden?: boolean;
}

const CHAVE = 'sp.alwaysRun';

export function RunToggle({ world, hidden }: RunToggleProps) {
  /**
   * A escolha sobrevive ao recarregamento, e é uma preferência de CONFORTO —
   * mora no navegador, não no servidor. Guardá-la no perfil faria uma
   * troca de dispositivo carregar junto o jeito de andar de outro aparelho,
   * que é o oposto do que uma preferência de controle deve fazer.
   */
  const [ligado, setLigado] = useState(() => {
    try { return localStorage.getItem(CHAVE) === '1'; } catch { return false; }
  });

  // O `World` remonta quando a intenção muda (entrar numa live, visitar uma
  // casa). Sem isto, a preferência valeria até a primeira porta.
  useEffect(() => {
    if (world) world.input.alwaysRun = ligado;
  }, [world, ligado]);

  const alternar = useCallback(() => {
    setLigado((antes) => {
      const agora = !antes;
      try { localStorage.setItem(CHAVE, agora ? '1' : '0'); } catch { /* aba privada */ }
      return agora;
    });
  }, []);

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      // Nunca enquanto se escreve: "r" é uma letra antes de ser um atalho, e
      // roubá-la de um campo de texto é o clássico "o jogo comeu minha frase".
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      if (e.code !== 'KeyR') return;
      e.preventDefault();
      alternar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden, alternar]);

  if (hidden) return null;

  return (
    <div className="runtoggle">
      <button
        type="button"
        className={`runtoggle__btn${ligado ? ' is-on' : ''}`}
        onClick={alternar}
        aria-pressed={ligado}
        title={ligado
          ? 'Correndo (R para desligar; segure Shift para andar)'
          : 'Andando (R para correr sempre; ou segure Shift)'}
      >
        <IconRun size={20} />
        <span className="runtoggle__label">{ligado ? 'Correr' : 'Andar'}</span>
        <span className="runtoggle__tecla" aria-hidden>R</span>
      </button>
    </div>
  );
}
