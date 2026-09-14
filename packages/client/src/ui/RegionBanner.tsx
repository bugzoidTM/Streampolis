import { useEffect, useState } from 'react';
import { useRegionStore } from '../state/useMinimapStore.js';
import './region.css';

/**
 * O nome da região, por alguns segundos, ao entrar numa cena. Sem bloquear
 * nada: `pointer-events: none`, sem foco, sem botão — é um letreiro que passa.
 * `tick` muda a cada entrada, então voltar à mesma praça mostra de novo.
 */
export function RegionBanner() {
  const name = useRegionStore((s) => s.name);
  const tick = useRegionStore((s) => s.tick);
  const [shown, setShown] = useState<{ name: string; tick: number } | null>(null);

  useEffect(() => {
    if (!name || tick === 0) return;
    setShown({ name, tick });
    const id = window.setTimeout(() => setShown((cur) => (cur?.tick === tick ? null : cur)), 3_200);
    return () => window.clearTimeout(id);
  }, [name, tick]);

  if (!shown) return null;
  return (
    <div className="region" key={shown.tick} aria-live="polite">
      <span className="region__eyebrow">Você está em</span>
      <span className="region__name">{shown.name}</span>
    </div>
  );
}
