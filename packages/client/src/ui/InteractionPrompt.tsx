import { useEffect } from 'react';
import type { Portal } from '@streampolis/shared';
import type { InteractionTarget } from '../game/World.js';
import { useChatStore } from '../state/useChatStore.js';
import './portal.css';

/**
 * O convite de interação: UM por vez.
 *
 * O mundo escolhe o alvo (`World.pickInteraction`: porta ou personagem mais
 * alinhado com a câmera entre os que estão ao alcance); aqui só se mostra e
 * se atende — E no teclado, toque no próprio aviso. Porta atravessa;
 * personagem abre o chat com o nome já escrito, que é o jeito de falar com
 * ele (a conversa continua sendo a do servidor). Sucede o `PortalPrompt`.
 */
export interface InteractionPromptProps {
  target: InteractionTarget | null;
  onEnter: (portal: Portal) => void;
}

export function InteractionPrompt({ target, onEnter }: InteractionPromptProps) {
  const act = () => {
    if (!target) return;
    if (target.kind === 'portal') onEnter(target.portal);
    else {
      const chat = useChatStore.getState();
      const prefix = `${target.name}, `;
      if (!chat.draft.startsWith(prefix)) chat.setDraft(prefix + chat.draft.replace(/^[^,]{2,24},\s*/, ''));
      chat.requestFocus();
    }
  };

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      // Nunca enquanto se escreve: "e" é uma letra antes de ser um atalho.
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        act();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!target) return null;
  const label = target.kind === 'portal' ? target.portal.label : `Falar com ${target.name}`;
  return (
    <button type="button" className={`portal${target.kind === 'npc' ? ' portal--npc' : ''}`} onClick={act}>
      <span className="portal__key" aria-hidden="true">E</span>
      <span className="portal__label">{label}</span>
    </button>
  );
}
