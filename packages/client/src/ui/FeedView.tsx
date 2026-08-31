import { useEffect, useMemo, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import type { ApiLive } from '../network/api.js';
import { short, since } from '../state/format.js';
import { usePoster } from './usePoster.js';
import { Button, LiveDot, Segmented } from './primitives/Controls.js';
import { IconEye, IconHeartFilled, IconSwords, IconUser } from './Icons.js';

/**
 * Feed (PRD §11).
 *
 * É a porta de entrada do produto, e a vantagem sobre um feed de vídeo é que a
 * capa não precisa de vídeo nenhum: o card mostra o AVATAR do host, renderizado
 * pelo nosso próprio Three.js. Tocar num card não abre um player — entra na
 * sala, no mundo, com a mesma conexão que o jogo usa.
 *
 * A lista vem da API e os números ao vivo vêm do game server; um card sem
 * `roomId` nunca aparece, porque seria uma live que ninguém consegue assistir.
 */

export type FeedFilter = 'todos' | 'seguindo' | 'pk';

export interface FeedViewProps {
  /** Entrar na live: o shell troca o mundo para a sala dela. */
  onWatch: (live: ApiLive) => void;
  onOpenProfile: (userId: string) => void;
  onGoLive: () => void;
}

export function FeedView({ onWatch, onOpenProfile, onGoLive }: FeedViewProps) {
  const lives = useAccountStore((s) => s.lives);
  const status = useAccountStore((s) => s.livesState);
  const following = useAccountStore((s) => s.following);
  const loadLives = useAccountStore((s) => s.loadLives);
  const [filter, setFilter] = useState<FeedFilter>('todos');

  useEffect(() => { void loadLives(); }, [loadLives]);

  const visible = useMemo(() => {
    if (filter === 'pk') return lives.filter((l) => l.isPK);
    if (filter === 'seguindo') return lives.filter((l) => following.has(l.hostId));
    return lives;
  }, [lives, filter, following]);

  return (
    <section className="screen feed">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Streampolis</h1>
          <p className="screen__sub">Quem está ao vivo agora</p>
        </div>
        <Button variant="live" onClick={onGoLive}>Abrir live</Button>
      </header>

      <Segmented
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'todos', label: 'Para você' },
          { id: 'seguindo', label: 'Seguindo' },
          { id: 'pk', label: 'PK' },
        ]}
      />

      {status === 'loading' && <p className="screen__hint">Carregando…</p>}

      {status !== 'loading' && visible.length === 0 && (
        <div className="feed__empty">
          <strong>Ninguém ao vivo por aqui.</strong>
          <p>
            {filter === 'seguindo'
              ? 'As pessoas que você segue aparecem aqui quando abrirem uma live.'
              : 'Seja a primeira pessoa no ar hoje.'}
          </p>
          <Button variant="primary" onClick={onGoLive}>Abrir a minha live</Button>
        </div>
      )}

      <div className="feed__grid">
        {visible.map((live) => (
          <LiveCard
            key={live.roomId}
            live={live}
            onWatch={() => onWatch(live)}
            onProfile={() => onOpenProfile(live.hostId)}
          />
        ))}
      </div>
    </section>
  );
}

function LiveCard({ live, onWatch, onProfile }: { live: ApiLive; onWatch: () => void; onProfile: () => void }) {
  const poster = usePoster(live.hostAvatar as AvatarConfig | null, {
    shot: 'full', pose: live.isPK ? 'pkWin' : 'idle', at: live.isPK ? 1.3 : 1.6,
    width: 300, height: 420, rim: hueOf(live.roomId),
  });

  return (
    <article className="card" style={{ '--hue': `${hueDeg(live.roomId)}deg` } as React.CSSProperties}>
      <button type="button" className="card__art" onClick={onWatch} aria-label={`Assistir ${live.hostName}`}>
        {poster
          ? <img className="card__poster" src={poster} alt="" />
          : <span className="card__skeleton" aria-hidden><IconUser size={44} /></span>}

        <span className="card__badges">
          <LiveDot />
          {live.isPK && <span className="chip chip--pk"><IconSwords size={13} /> PK</span>}
        </span>
        <span className="card__viewers"><IconEye size={14} /> <span className="sp-num">{short(live.realViewers)}</span></span>
      </button>

      <div className="card__body">
        <h3 className="card__title" title={live.title}>{live.title}</h3>
        <div className="card__meta">
          <button type="button" className="card__host" onClick={onProfile}>
            {live.hostName}
          </button>
          <span className="card__dot">·</span>
          <span className="card__cat">{live.category}</span>
        </div>
        <div className="card__foot">
          <span className="sp-num"><IconHeartFilled size={13} /> {short(live.likes)}</span>
          <span>{since(live.startedAt)}</span>
        </div>
      </div>
    </article>
  );
}

/** Matiz estável por sala: a arte do card não pode piscar a cada atualização. */
function hueDeg(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

function hueOf(seed: string): number {
  const hue = hueDeg(seed) / 360;
  const c = 0.55;
  const f = (n: number) => {
    const k = (n + hue * 6) % 6;
    return Math.round(255 * (0.55 + c * Math.max(-1, Math.min(1, Math.min(k - 3, 5 - k) * 0.6))));
  };
  return (f(5) << 16) | (f(3) << 8) | f(1);
}
