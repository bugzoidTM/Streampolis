import { useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../state/useChatStore.js';
import { gifterTierFor } from '@streampolis/shared';
import { GifterBadge } from '../primitives/Controls.js';
import type { World } from '../../game/World.js';
import './chat.css';

/**
 * O chat da PRAÇA — e de qualquer sala em que se ande.
 *
 * O PRD §6 diz o que a Praça Central serve para: encontrar jogadores,
 * **conversar**, ver perfis, seguir, e chegar aos outros lugares. O servidor
 * já tinha o chat inteiro (fila, filtro, silenciamento, bloqueio — SPECs §31)
 * e o painel da live já falava com ele; o mundo, que é onde as pessoas
 * realmente se encontram, era mudo.
 *
 * Três decisões:
 *
 * - **Enter abre, Enter manda, Esc fecha.** Um chat de jogo que exige o mouse
 *   para começar a escrever não é usado. Enquanto o campo está em foco, o
 *   teclado do JOGO é suspenso (ver `World.setTyping`), senão escrever "vamos"
 *   sai andando.
 * - **Fechado, ele continua mostrando as últimas falas** e some sozinho. Um
 *   histórico permanente rouba um quarto da tela de um jogo 3D; nenhum
 *   histórico faz perder o que foi dito enquanto se olhava para outro lado.
 * - **A fala aparece no MUNDO**, em balão sobre a cabeça (`SpeechBubble`).
 *   Este painel é a memória; o balão é a conversa.
 */
export interface WorldChatProps {
  world: World | null;
  /** A live tem o chat dela, com presentes e PK. Dois seria um dentro do outro. */
  hidden?: boolean;
}

/** Quanto tempo uma fala fica visível com o painel fechado. */
const QUIET_MS = 9_000;

export function WorldChat({ world, hidden }: WorldChatProps) {
  const messages = useChatStore((s) => s.messages);
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const send = useChatStore((s) => s.send);

  const [typing, setTyping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // O jogo para de ouvir o teclado enquanto se digita, e volta a ouvir ao
  // sair. Em `world` porque é o dono do `InputManager` — a UI não conhece
  // tecla de movimento nenhuma.
  useEffect(() => {
    world?.setTyping(typing);
    return () => world?.setTyping(false);
  }, [world, typing]);

  // Enter em qualquer lugar começa a falar. Ignorado quando o foco já está num
  // campo (o compositor da live, uma busca da loja): roubar o Enter de outro
  // formulário é como se quebra uma tela sem perceber.
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const inField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      if (e.key === 'Enter' && !inField) {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape' && el === inputRef.current) inputRef.current?.blur();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden]);

  // Relógio de baixa frequência, só para as falas antigas sumirem sozinhas com
  // o painel fechado. 1 Hz: isto não é animação.
  useEffect(() => {
    if (typing) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [typing]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  const visible = useMemo(() => {
    const recent = messages.slice(-40);
    if (typing) return recent;
    // Fechado: só o que foi dito há pouco, e no máximo cinco linhas.
    return recent.filter((m) => now - m.ts < QUIET_MS).slice(-5);
  }, [messages, typing, now]);

  if (hidden) return null;

  return (
    <div className={`wchat${typing ? ' wchat--open' : ''}`}>
      <div className="wchat__log sp-scroll" ref={listRef} role="log" aria-label="Conversa">
        {visible.map((m) => (
          <div key={m.id} className={`wchat__line wchat__line--${m.kind}`}>
            {m.sender && (
              <>
                <GifterBadge xp={m.sender.gifterXp} size="sm" compact />
                <span
                  className="wchat__name"
                  style={{ color: gifterTierFor(m.sender.gifterXp).color }}
                >
                  {m.sender.name}
                </span>
              </>
            )}
            <span className="wchat__text">{m.text}</span>
          </div>
        ))}
      </div>

      <form
        className="wchat__composer"
        onSubmit={(e) => { e.preventDefault(); send(); inputRef.current?.focus(); }}
      >
        <input
          ref={inputRef}
          className="wchat__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={typing ? 'Diga alguma coisa…' : 'Enter para falar'}
          maxLength={200}
          aria-label="Falar com quem está por perto"
        />
      </form>
    </div>
  );
}
