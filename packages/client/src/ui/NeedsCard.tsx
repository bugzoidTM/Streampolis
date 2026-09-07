import { useEffect, useState } from 'react';
import type { NeedView } from '../network/api.js';
import { useAccountStore } from '../state/useAccountStore.js';

/**
 * Necessidades do personagem (PRD §9).
 *
 * Quatro barras no próprio perfil, e nada mais: elas não travam ação nenhuma e
 * não dão bônus. O §9 é explícito ("não deverão impedir o jogador de participar
 * do jogo de maneira excessivamente punitiva") e diz para que servem — "criar
 * decisões e incentivar variedade".
 *
 * É por isso que a DICA é a parte importante do componente, não o número. Cada
 * uma aponta para um canto diferente do jogo: a praça, a casa, a loja, o palco.
 * Uma barra sem dica seria só uma cobrança sem instrução.
 *
 * Só aparece no próprio perfil. O humor de outra pessoa não é da conta de
 * ninguém, e a energia dela seria informação tática sobre quando ela vai parar
 * de transmitir.
 */

const COR = (v: number) => (v < 30 ? 'is-low' : v < 60 ? 'is-mid' : 'is-ok');

export function NeedsCard() {
  const api = useAccountStore((s) => s.api);
  const [views, setViews] = useState<NeedView[] | null>(null);

  useEffect(() => {
    let vivo = true;
    void api?.needs()
      .then((r) => { if (vivo) setViews(r.views); })
      .catch(() => { /* necessidade é enfeite: perfil abre sem ela */ });
    return () => { vivo = false; };
  }, [api]);

  if (!views || views.length === 0) return null;

  return (
    <section className="needs" aria-label="Como você está">
      {views.map((n) => (
        <div key={n.id} className="need">
          <div className="need__top">
            <span className="need__label">{n.label}</span>
            <span className="sp-num need__value">{n.value}</span>
          </div>
          <div
            className="need__bar"
            role="progressbar"
            aria-valuenow={n.value}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={n.label}
          >
            <div className={`need__fill ${COR(n.value)}`} style={{ width: `${n.value}%` }} />
          </div>
          <p className="need__hint">{n.hint}</p>
        </div>
      ))}
    </section>
  );
}
