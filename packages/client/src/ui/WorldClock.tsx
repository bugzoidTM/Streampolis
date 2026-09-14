import { formatClock, daylight } from '@streampolis/shared';
import { useClockStore } from '../state/useClockStore.js';
import './worldclock.css';

/**
 * O relógio do mundo no HUD. Só desenha o que a sala publicou (`state.clock`,
 * via `useClockStore`); nenhuma conta de hora acontece aqui. O ponto ao lado
 * é o sol ou a lua — desenhado em CSS, nunca emoji.
 */
export function WorldClock({ hidden }: { hidden?: boolean }) {
  const minutes = useClockStore((s) => s.minutes);
  const weather = useClockStore((s) => s.weather);
  if (hidden || minutes === null) return null;
  const day = daylight(minutes) > 0.5;
  const rain = weather === 'rain';
  return (
    <div
      className={`wclock${day ? ' is-day' : ' is-night'}${rain ? ' is-rain' : ''}`}
      aria-label={`Hora do mundo: ${formatClock(minutes)}${rain ? ', chovendo' : ''}`}
      title={rain ? 'Hora do mundo · chovendo' : 'Hora do mundo'}
    >
      <span className="wclock__orb" aria-hidden />
      <span className="wclock__time">{formatClock(minutes)}</span>
      {rain && <span className="wclock__rain" aria-hidden><i /><i /><i /></span>}
    </div>
  );
}
