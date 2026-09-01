import { useEffect, useMemo, useRef, useState } from 'react';
import { ITEM_CATALOG, PLACEABLES, type HomePlacement } from '@streampolis/shared';
import { BuildMode } from '../game/BuildMode.js';
import type { World } from '../game/World.js';
import { useAccountStore } from '../state/useAccountStore.js';
import './build.css';

/**
 * Build Mode Lite, as a screen.
 *
 * The loop this closes is the one the whole economy hangs off: earn, buy,
 * place, be visited. A shop that sells a sofa nobody can put anywhere sells a
 * receipt.
 *
 * What it deliberately does NOT do: walls, floors, free rotation, stacking
 * rules. Everything here is place / move / rotate / store, and the grid keeps
 * a room from looking like a repossession.
 */

export interface BuildBarProps {
  world: World | null;
  /** Which apartment is open. Null when the scene is not an apartment. */
  apartmentId: string | null;
}

interface Draft { list: HomePlacement[]; selected: number }

export function BuildBar({ world, apartmentId }: BuildBarProps) {
  const api = useAccountStore((s) => s.api);
  const owned = useAccountStore((s) => s.owned);

  const [open, setOpen] = useState(false);
  /** Só o dono redecora. Visitante vê a mobília DELE, não a sua. */
  const [mine, setMine] = useState(false);
  const [draft, setDraft] = useState<Draft>({ list: [], selected: -1 });
  const [saved, setSaved] = useState<HomePlacement[]>([]);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const modeRef = useRef<BuildMode | null>(null);

  // What the player owns AND can put down. An item with no geometry behind it
  // is not offered, which is how the accessory bug stayed invisible for weeks.
  const palette = useMemo(
    () => ITEM_CATALOG.filter((i) => PLACEABLES[i.id] && owned.has(i.id)),
    [owned],
  );

  // Load the saved layout and show it, whether or not build mode is on: a
  // visitor has to see the furniture too.
  useEffect(() => {
    if (!world || !api?.authenticated || !apartmentId) return;
    let alive = true;
    // A casa ABERTA, não a minha. Carregar `/me/home` numa visita mostrava a
    // mobília do visitante na sala do anfitrião.
    Promise.all([api.home(), api.homeOf(apartmentId)])
      .then(([own, here]) => {
        if (!alive) return;
        const owner = own.home.apartmentId === apartmentId;
        setMine(owner);
        setSaved(here.home.decor);
        setDraft({ list: here.home.decor.map((p) => ({ ...p })), selected: -1 });
        world.applyHomeLayout(here.home.decor);
      })
      .catch(() => { /* offline ou casa fechada: a sala fica com os fixos */ });
    return () => { alive = false; };
  }, [world, api, apartmentId]);

  useEffect(() => {
    if (!open || !world) return;
    const target = world.editable;
    if (!target) return;

    const mode = new BuildMode({
      canvas: target.canvas,
      camera: target.camera,
      scene: target.scene,
      bounds: { halfW: 4.4, halfD: 3.4 },
      onChange: (list, selected) => setDraft({ list, selected }),
    });
    mode.load(draft.list);
    mode.enable();
    modeRef.current = mode;
    return () => { mode.dispose(); modeRef.current = null; };
    // draft.list is intentionally not a dependency: the mode owns it once open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, world]);

  if (!mine) return null;

  const dirty = JSON.stringify(draft.list) !== JSON.stringify(saved);

  const save = async () => {
    if (!api?.authenticated) return;
    setBusy(true);
    try {
      const { home } = await api.saveHomeLayout(draft.list);
      setSaved(home.decor);
      setStatus('Salvo');
      world?.applyHomeLayout(home.decor);
    } catch (err) {
      // The server refuses for reasons the client already checks, so this is
      // a real disagreement and worth showing verbatim rather than "erro".
      setStatus(err instanceof Error ? err.message : 'Não deu para salvar');
    } finally {
      setBusy(false);
      setTimeout(() => setStatus(''), 2400);
    }
  };

  const revert = () => {
    setDraft({ list: saved.map((p) => ({ ...p })), selected: -1 });
    modeRef.current?.load(saved);
    world?.applyHomeLayout(saved);
  };

  if (!open) {
    return (
      <button className="build__open" onClick={() => setOpen(true)}>
        Decorar
      </button>
    );
  }

  const selected = draft.selected >= 0 ? draft.list[draft.selected] : null;
  const selectedName = selected
    ? ITEM_CATALOG.find((i) => i.id === selected.itemId)?.name ?? selected.itemId
    : null;

  return (
    <div className="build">
      <div className="build__head">
        <strong>Decorar</strong>
        <span className="build__hint">
          Arraste para mover · <kbd>R</kbd> girar · <kbd>Del</kbd> guardar
        </span>
        <button className="build__close" onClick={() => { setOpen(false); revert(); }}>Sair</button>
      </div>

      <div className="build__palette">
        {palette.length === 0 && (
          <p className="build__empty">Nada para colocar ainda. A loja tem móveis.</p>
        )}
        {palette.map((item) => (
          <button
            key={item.id}
            className="build__item"
            onClick={() => {
              if (!modeRef.current?.add(item.id)) setStatus('Não coube — abra espaço');
            }}
          >
            {item.name}
          </button>
        ))}
      </div>

      <div className="build__actions">
        {selected && (
          <>
            <span className="build__selected">{selectedName}</span>
            <button onClick={() => modeRef.current?.rotate()}>Girar</button>
            <button onClick={() => modeRef.current?.store()}>Guardar</button>
          </>
        )}
        <span className="build__spacer" />
        {status && <span className="build__status">{status}</span>}
        <button disabled={!dirty || busy} onClick={revert}>Desfazer</button>
        <button className="build__save" disabled={!dirty || busy} onClick={save}>
          {busy ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}
