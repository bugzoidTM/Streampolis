import { useEffect, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { renderPoster, type PosterOptions } from '../game/portrait/PosterStudio.js';

/**
 * Retrato 3D de um avatar, renderizado fora da tela e entregue como PNG.
 *
 * Devolve `null` enquanto a fila não chega neste card — a UI mostra o
 * esqueleto nesse intervalo em vez de travar esperando o render.
 */
export function usePoster(config: AvatarConfig | null | undefined, options: PosterOptions = {}): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = config ? JSON.stringify(config) : '';
  const opts = JSON.stringify(options);

  useEffect(() => {
    if (!config) { setUrl(null); return; }
    let alive = true;
    renderPoster(config, options)
      .then((data) => { if (alive) setUrl(data); })
      .catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
    // As dependências são os VALORES serializados: um objeto novo a cada render
    // com o mesmo conteúdo re-renderizaria o retrato para sempre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, opts]);

  return url;
}
