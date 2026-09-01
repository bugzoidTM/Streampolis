import { useMemo, useState } from 'react';
import { ITEM_BY_ID, type AvatarConfig, type ItemType } from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import {
  BODY_PRESET_LABELS, FACE_PRESET_LABELS, HAIR_SWATCHES, SKIN_SWATCHES,
  itemSwatch, wearablesOfType,
} from '../state/avatarOptions.js';
import { usePoster } from './usePoster.js';
import { Button, Segmented } from './primitives/Controls.js';
import './avatar.css';

/**
 * O criador de avatar (PRD §7).
 *
 * Estava na lista do MVP e não existia: "Editar look" no perfil mandava o
 * jogador para `?view=lab`, que é a bancada de revisão visual do time — um
 * lugar com folhas de contato e matriz de 176 combinações. As listas de opções
 * já estavam escritas em `state/avatarOptions.ts` esperando por esta tela.
 *
 * Três decisões:
 *
 * - **Nada é salvo enquanto se experimenta.** As mudanças ficam num rascunho
 *   local e só viram `PUT /me/avatar` no botão Salvar. Salvar a cada clique
 *   assinaria um token novo por toque de paleta e faria o mundo repintar o
 *   avatar dezenas de vezes.
 * - **Peça que não se possui aparece, mas não veste.** Esconder o catálogo
 *   deixa a loja invisível para quem está justamente escolhendo roupa; deixar
 *   vestir seria mentir, porque o servidor recusa (e recusa com razão).
 * - **O retrato mostra o RASCUNHO.** É o único jeito de responder "como isso
 *   fica em mim?" sem comprar — e é o mesmo renderizador dos cards da loja.
 */
export interface AvatarViewProps {
  onClose: () => void;
}

type TabId = 'corpo' | 'cabelo' | 'roupa';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'corpo', label: 'Corpo' },
  { id: 'cabelo', label: 'Cabelo' },
  { id: 'roupa', label: 'Roupa' },
];

const SLOTS: Array<{ type: ItemType; key: keyof AvatarConfig; label: string }> = [
  { type: 'top', key: 'top', label: 'Camiseta' },
  { type: 'bottom', key: 'bottom', label: 'Calça' },
  { type: 'shoes', key: 'shoes', label: 'Calçado' },
  { type: 'accessory', key: 'accessory', label: 'Acessório' },
];

export function AvatarView({ onClose }: AvatarViewProps) {
  const saved = useAccountStore((s) => s.avatar);
  const owned = useAccountStore((s) => s.owned);
  const wear = useAccountStore((s) => s.wear);

  const [draft, setDraft] = useState<AvatarConfig | null>(null);
  const [tab, setTab] = useState<TabId>('corpo');
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const config = draft ?? saved;
  const poster = usePoster(config, { shot: 'full', at: 1.9, width: 420, height: 580 });
  const dirty = useMemo(
    () => Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)),
    [draft, saved],
  );

  if (!config) {
    return <section className="screen"><p className="screen__hint">Carregando seu visual…</p></section>;
  }

  const set = (patch: Partial<AvatarConfig>) => {
    setStatus(null);
    setDraft({ ...config, ...patch });
  };

  /** Grátis ou comprado. A mesma regra que a API aplica do outro lado. */
  const wearable = (id: string) => {
    const item = ITEM_BY_ID.get(id);
    if (!item) return false;
    return owned.has(id) || item.creditsPrice === 0 || item.coinsPrice === 0;
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    const result = await wear(draft);
    setSaving(false);
    setStatus(result.message);
    if (result.ok) setDraft(null);
  };

  return (
    <section className="screen look">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Seu visual</h1>
          <p className="screen__sub">Corpo, rosto, cabelo e roupa</p>
        </div>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
      </header>

      <div className="look__body">
        <div className="look__stage">
          {poster
            ? <img className="look__poster" src={poster} alt="Seu avatar" />
            : <div className="look__poster look__poster--empty" />}
        </div>

        <div className="look__panel">
          <Segmented value={tab} onChange={setTab} options={TABS} />

          {tab === 'corpo' && (
            <>
              <Row label="Tom de pele">
                {SKIN_SWATCHES.map((hex, i) => (
                  <Swatch
                    key={hex} color={hex} on={config.skinTone === i}
                    label={`Tom ${i + 1}`} onClick={() => set({ skinTone: i })}
                  />
                ))}
              </Row>

              <Row label="Rosto">
                {FACE_PRESET_LABELS.map((name, i) => (
                  <Chip key={name} on={config.facePreset === i} onClick={() => set({ facePreset: i })}>
                    {name}
                  </Chip>
                ))}
              </Row>

              <Row label="Corpo">
                {BODY_PRESET_LABELS.map((name, i) => (
                  <Chip key={name} on={config.bodyPreset === i} onClick={() => set({ bodyPreset: i })}>
                    {name}
                  </Chip>
                ))}
              </Row>

              <label className="look__slider">
                <span>Altura</span>
                {/* A faixa é a do PRD §7 e é a mesma que a API prende: altura
                    fora dela vira vantagem visual, não estilo. */}
                <input
                  type="range" min={0.92} max={1.08} step={0.01}
                  value={config.height}
                  onChange={(e) => set({ height: Number(e.target.value) })}
                />
                <span className="sp-num">{Math.round(config.height * 100)}%</span>
              </label>
            </>
          )}

          {tab === 'cabelo' && (
            <>
              <Row label="Corte">
                <Chip on={config.hair === ''} onClick={() => set({ hair: '' })}>Nenhum</Chip>
                {wearablesOfType('hair').map((item) => (
                  <Chip
                    key={item.id} on={config.hair === item.id}
                    locked={!wearable(item.id)}
                    onClick={() => wearable(item.id) && set({ hair: item.id })}
                  >
                    {item.name}
                  </Chip>
                ))}
              </Row>

              <Row label="Cor">
                {HAIR_SWATCHES.map((hex, i) => (
                  <Swatch
                    key={hex} color={hex} on={config.hairColor === i}
                    label={`Cor ${i + 1}`} onClick={() => set({ hairColor: i })}
                  />
                ))}
              </Row>
            </>
          )}

          {tab === 'roupa' && SLOTS.map((slot) => (
            <Row key={slot.key} label={slot.label}>
              <Chip
                on={config[slot.key] === ''}
                onClick={() => set({ [slot.key]: '' } as Partial<AvatarConfig>)}
              >
                Nenhum
              </Chip>
              {wearablesOfType(slot.type).map((item) => (
                <Chip
                  key={item.id} on={config[slot.key] === item.id}
                  locked={!wearable(item.id)}
                  swatch={itemSwatch(item.id)}
                  onClick={() => wearable(item.id) && set({ [slot.key]: item.id } as Partial<AvatarConfig>)}
                >
                  {item.name}
                </Chip>
              ))}
            </Row>
          ))}
        </div>
      </div>

      <footer className="look__foot">
        {status && <p className="look__status">{status}</p>}
        <div className="look__actions">
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setDraft(null)}>
            Desfazer
          </Button>
          <Button disabled={!dirty || saving} onClick={save}>
            {saving ? 'Salvando…' : 'Salvar'}
          </Button>
        </div>
      </footer>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="look__row">
      <p className="look__rowLabel">{label}</p>
      <div className="look__options">{children}</div>
    </div>
  );
}

function Swatch({ color, on, label, onClick }: {
  color: string; on: boolean; label: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`look__swatch${on ? ' is-on' : ''}`}
      style={{ background: color }}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
    />
  );
}

function Chip({ children, on, locked, swatch, onClick }: {
  children: React.ReactNode; on: boolean; locked?: boolean; swatch?: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`look__chip${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
      aria-pressed={on}
      // Continua clicável de propósito: o clique não veste, e o rótulo explica
      // por quê. Um botão morto sem explicação lê como defeito.
      onClick={onClick}
      title={locked ? 'Disponível na Loja' : undefined}
    >
      {swatch && <i className="look__chipDot" style={{ background: swatch }} />}
      {children}
      {locked && <span className="look__lock">Loja</span>}
    </button>
  );
}
