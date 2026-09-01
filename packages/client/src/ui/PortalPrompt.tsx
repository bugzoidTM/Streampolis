import { useEffect } from 'react';
import type { Portal } from '@streampolis/shared';
import './portal.css';

/**
 * O convite para atravessar uma porta.
 *
 * Aparece quando o jogador entra no alcance de um portal e some quando ele sai
 * — não é um botão de menu, é uma coisa do lugar onde ele está. Serve ao teclado
 * (E) e ao toque (o próprio aviso é o botão), porque metade do público joga em
 * telefone e um atalho de teclado sozinho tranca essa metade do lado de fora.
 */
export interface PortalPromptProps {
  portal: Portal | null;
  onEnter: (portal: Portal) => void;
}

export function PortalPrompt({ portal, onEnter }: PortalPromptProps) {
  useEffect(() => {
    if (!portal) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      // Nunca enquanto se escreve: "e" é uma letra antes de ser um atalho, e
      // roubá-la de um campo de texto é o clássico "o jogo comeu minha frase".
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        onEnter(portal);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [portal, onEnter]);

  if (!portal) return null;

  return (
    <button type="button" className="portal" onClick={() => onEnter(portal)}>
      <span className="portal__key" aria-hidden="true">E</span>
      <span className="portal__label">{portal.label}</span>
    </button>
  );
}
