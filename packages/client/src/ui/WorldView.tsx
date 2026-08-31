import { useEffect, useRef, useState } from 'react';
import type { AvatarConfig, SceneId } from '@streampolis/shared';
import { World } from '../game/World.js';

export interface WorldViewProps {
  sceneId?: SceneId;
  tier?: 'low' | 'medium' | 'high';
  token?: string;
  displayName?: string;
  avatar?: AvatarConfig;
  endpoint?: string;
}

/**
 * Mounts the 3D world. React owns the canvas element and nothing else — the
 * render loop lives in `World` and never touches component state, so a busy
 * plaza does not re-render the UI sixty times a second.
 */
export function WorldView(props: WorldViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'online' | 'offline' | 'failed'>('loading');

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const world = new World({ canvas, ...props });
    let cancelled = false;

    world
      .start()
      .then(() => { if (!cancelled) setStatus(world.online ? 'online' : 'offline'); })
      .catch((err) => {
        console.error('[world] falhou ao iniciar:', err);
        if (!cancelled) setStatus('failed');
      });

    const onResize = () => world.resize();
    window.addEventListener('resize', onResize);
    // Debug surface for tools/shoot.mjs and tools/probe.mjs. Read-only apart
    // from `anim`, which the visual review uses to photograph a pose.
    Object.assign(window as object, {
      __lab: {
        stats: () => world.stats(),
        anim: (state: string | null) => world.forceAnim(state as never),
        animReport: () => world.animReport(),
        capture: () => world.capture(),
      },
      __world: world,
    });

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      world.dispose();
    };
    // Restarting the world on a prop change would tear down the scene mid-play;
    // the props are read once, at mount, on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <canvas
        ref={ref}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block', background: '#0b0d12' }}
      />
      {status !== 'online' && (
        <div className="world-status" role="status">
          {status === 'loading' && 'Carregando a praça…'}
          {status === 'offline' && 'Modo offline — sem servidor de jogo'}
          {status === 'failed' && 'Não foi possível carregar a cena'}
        </div>
      )}
    </>
  );
}
