import { useEffect, useState } from 'react';
import { useGigStore, gigSecondsLeft } from '../state/useGigStore.js';
import { IconCheck, IconCredits, IconFlame } from './Icons.js';

/**
 * A faixa do bico em andamento (PRD §26).
 *
 * Fica sobre o mundo, não dentro de um painel: um jogador correndo uma entrega
 * está ANDANDO, e informação que só existe atrás de um botão não é informação
 * para quem está com as duas mãos no teclado. Ela mostra três coisas, e não uma
 * a mais: para onde ir, quanto tempo falta e quanto vale.
 *
 * ## O relógio é derivado, não contado
 *
 * O prazo é um instante que veio do servidor, e o que a tela faz é subtrair o
 * relógio local dele uma vez por segundo. A alternativa — um contador que
 * decrementa sozinho — diverge do prazo real na primeira vez que a aba vai para
 * segundo plano, porque o navegador estrangula o `setInterval`; o jogador
 * voltaria com meio minuto a mais na tela e a entrega falharia com o relógio
 * ainda correndo.
 *
 * ## O aviso de pagamento some sozinho
 *
 * Uma entrega paga aparece por quatro segundos e sai. Um aviso que exige clique
 * para fechar interrompe a corrida seguinte — e é sempre a corrida seguinte que
 * o jogador quer começar.
 */

const AVISO_MS = 4_000;

function relogio(segundos: number): string {
  if (segundos <= 0) return '0:00';
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function GigTracker() {
  const run = useGigStore((s) => s.run);
  const paid = useGigStore((s) => s.paid);
  const clearPaid = useGigStore((s) => s.clearPaid);
  const heat = useGigStore((s) => s.board?.heat ?? 0);

  // Um tique por segundo só para forçar o redesenho; o VALOR sai do prazo.
  const [, setAgora] = useState(0);
  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setAgora((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [run]);

  useEffect(() => {
    if (!paid) return;
    const t = setTimeout(clearPaid, AVISO_MS);
    return () => clearTimeout(t);
  }, [paid, clearPaid]);

  if (paid) {
    return (
      <div className="gigtrack gigtrack--paid" role="status">
        <IconCheck size={16} />
        <span className="gigtrack__title">Entregue</span>
        <span className="gigtrack__pay">
          <IconCredits size={14} />
          <span className="sp-num">+{paid.credits}</span>
        </span>
      </div>
    );
  }

  if (!run || !run.next) return null;

  const restante = gigSecondsLeft(run);
  // "Apertado" começa em 20 s. Não é enfeite: é o intervalo em que ainda dá
  // para atravessar a avenida correndo, e é a única hora em que um alerta
  // muda uma decisão.
  const apertado = restante <= 20;

  return (
    <div className="gigtrack" role="status" aria-live="polite">
      <div className="gigtrack__head">
        <span className="gigtrack__title">{run.title}</span>
        {heat > 0 && (
          <span className="gigtrack__heat" aria-label={`Atenção ${heat}`}>
            <IconFlame size={13} />
            <span className="sp-num">{heat}</span>
          </span>
        )}
        <span className={apertado ? 'gigtrack__clock is-tight' : 'gigtrack__clock'}>
          <span className="sp-num">{relogio(restante)}</span>
        </span>
      </div>
      <p className="gigtrack__stop">
        <span className="gigtrack__step">{run.stopsDone + 1}/{run.stops.length}</span>
        {run.next.hint}
      </p>
    </div>
  );
}
