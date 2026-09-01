import { useEffect, useRef, useState } from 'react';
import type { LoadReport } from '../game/assets/loading.js';
import './loading.css';

/**
 * A tela de carregamento.
 *
 * Entrar no jogo mostrava uma tela PRETA com uma linha de texto no canto por
 * vários segundos, e o passe de assets piorou isso — a praça agora busca GLBs
 * e um HDRI antes do primeiro quadro. Tela preta que demora não parece que
 * está carregando; parece que travou, e é literalmente o que o dono relatou.
 *
 * Três decisões:
 *
 * - **A barra mede coisa real.** Vem do contador de arquivos do three e das
 *   fases que o mundo anuncia. Barra animada por tempo é pior que barra
 *   nenhuma: quando ela chega a 90% e para, a conclusão é a mesma.
 * - **A barra nunca anda para trás** e nunca fica parada de vez: um
 *   amortecedor a puxa em direção ao valor real, então mesmo entre dois passos
 *   ela continua se mexendo. Progresso que não se mexe lê como travado, mesmo
 *   quando não está.
 * - **Ela não some no zero.** Sai por fade depois de chegar ao fim, porque um
 *   corte seco para a cena 3D pisca.
 */
const HINTS = [
  'Segure o botão direito e arraste para girar a câmera.',
  'A roda do mouse aproxima e afasta o enquadramento.',
  'W, A, S e D andam. A praça é o ponto de encontro.',
  'Tudo o que você compra na Loja aparece no seu avatar para quem olhar.',
  'No seu apartamento, o botão Decorar abre o modo de construção.',
  'O telão da praça mostra quem está ao vivo agora.',
];

export interface LoadingScreenProps {
  report: LoadReport | null;
  /** Verdadeiro quando o mundo terminou; a tela sai sozinha depois disso. */
  done: boolean;
  /** Mensagem de erro; substitui a barra e não sai. */
  error?: string | null;
}

export function LoadingScreen({ report, done, error }: LoadingScreenProps) {
  const [shown, setShown] = useState(0);
  const [gone, setGone] = useState(false);
  const [hint] = useState(() => HINTS[Math.floor(Math.random() * HINTS.length)]);
  const target = useRef(0);

  target.current = done ? 1 : (report?.value ?? 0);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setShown((prev) => {
        // Amortecido em direção ao alvo. O `+0.0009` é o que impede a barra de
        // ficar imóvel enquanto um arquivo grande baixa sem relatar nada.
        const next = prev + (target.current - prev) * 0.08 + (prev < target.current ? 0.0009 : 0);
        return Math.min(target.current, next);
      });
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!done) return;
    // Sai só depois de a barra ENCHER de verdade: cortar em 80% porque o
    // mundo ficou pronto entrega a mentira que a barra estava evitando.
    const timer = window.setTimeout(() => setGone(true), 520);
    return () => window.clearTimeout(timer);
  }, [done]);

  if (gone && !error) return null;

  const pct = Math.round(shown * 100);
  const label = error ?? report?.label ?? 'Conectando…';

  return (
    <div
      className={`loading${done && !error ? ' loading--out' : ''}${error ? ' loading--error' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="loading__glow" aria-hidden="true" />
      <div className="loading__body">
        <p className="sp-eyebrow loading__eyebrow">Streampolis</p>
        <h1 className="loading__title">{error ? 'Não foi possível entrar' : 'Entrando'}</h1>

        {!error && (
          <div
            className="loading__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className="loading__fill" style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        )}

        <p className="loading__label">
          {label}
          {!error && <span className="loading__pct sp-num">{pct}%</span>}
        </p>

        {!error && <p className="loading__hint">{hint}</p>}
      </div>
    </div>
  );
}
