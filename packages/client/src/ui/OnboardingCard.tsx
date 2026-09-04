import type { Onboarding, OnboardingStep } from '../network/api.js';
import { Button } from './primitives/Controls.js';

/**
 * A volta guiada da conta nova (PRD §24).
 *
 * Cinco atos, na ordem em que o produto quer que a primeira sessão aconteça.
 * Não é uma lista de missões — não paga nada, não se repete e some para sempre
 * quando termina. É um mapa: alguém que acabou de chegar numa cidade 3D com
 * feed, loja, apartamento e live não sabe por onde começar, e a resposta
 * "explore" é a que faz a pessoa fechar a aba.
 *
 * Duas decisões de desenho:
 *
 * - **Só o próximo passo tem botão.** Cinco chamadas para ação ao mesmo tempo é
 *   um menu, não um roteiro; e o roteiro tem ordem por um motivo (não dá para
 *   abrir uma live antes de ter um rosto).
 * - **Nada aqui MARCA nada.** O que acende cada linha é o servidor tendo visto
 *   o ato acontecer (ver `Onboarding.ts` na API). Este componente só desenha o
 *   que ele respondeu.
 */

const ROTEIRO: Record<OnboardingStep, { label: string; cta: string }> = {
  create_avatar: { label: 'Monte o seu visual', cta: 'Editar look' },
  enter_plaza: { label: 'Dê uma volta na Praça Central', cta: 'Ir para a praça' },
  watch_live: { label: 'Assista a uma live', cta: 'Ver quem está no ar' },
  visit_apartment: { label: 'Entre num apartamento', cta: 'Abrir o meu' },
  open_live: { label: 'Abra a sua primeira live', cta: 'Go Live' },
};

export interface OnboardingCardProps {
  tour: Onboarding;
  /** Levar o jogador até onde o passo acontece. Quem navega é a casca. */
  onAction: (step: OnboardingStep) => void;
}

export function OnboardingCard({ tour, onAction }: OnboardingCardProps) {
  // Terminou: o cartão desaparece e não vira um troféu permanente ocupando o
  // topo do perfil de quem já joga há um mês.
  if (tour.done) return null;

  const pct = Math.round((tour.completed / tour.total) * 100);

  return (
    <section className="tour" aria-label="Primeiros passos">
      <header className="tour__head">
        <h2 className="tour__title">Primeiros passos</h2>
        <span className="tour__progress">{tour.completed} de {tour.total}</span>
      </header>

      <div className="tour__bar" role="progressbar" aria-valuenow={tour.completed} aria-valuemin={0} aria-valuemax={tour.total}>
        <div className="tour__fill" style={{ width: `${pct}%` }} />
      </div>

      <ul className="tour__list">
        {tour.steps.map((s) => (
          <li key={s.step} className={`tour__step${s.done ? ' is-done' : ''}`}>
            <span className="tour__mark" aria-hidden>{s.done ? '✓' : ''}</span>
            <span className="tour__label">{ROTEIRO[s.step].label}</span>
            {s.step === tour.next && (
              <Button size="sm" variant="primary" onClick={() => onAction(s.step)}>
                {ROTEIRO[s.step].cta}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
