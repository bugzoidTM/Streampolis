import { useMemo, useState } from 'react';
import {
  ITEM_BY_ID, type AvatarConfig, type Currency, type ItemDef, type ItemType,
} from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import { SHOP_TABS, shopItems, useShopStore, type ShopTab } from '../state/useShopStore.js';
import { short } from '../state/format.js';
import { usePoster } from './usePoster.js';
import { Button, Money, Notice, RarityTag, Segmented } from './primitives/Controls.js';
import { IconBag, IconCheck, IconCoin, IconCredits } from './Icons.js';

/**
 * Loja (PRD §13, §16).
 *
 * A pergunta que a tela precisa provocar é "quero essa roupa" — então a peça
 * não aparece como ícone: aparece VESTIDA no avatar de quem está olhando,
 * renderizada na hora. É o argumento de venda inteiro em uma imagem.
 *
 * O que a tela pode dizer ao servidor: qual item e com qual moeda. Preço, saldo
 * e posse são resposta (SPECs §68 regra 6) — por isso não existe subtração de
 * carteira em lugar nenhum deste arquivo.
 */

/** Slots que o avatar veste; o resto do catálogo mora no apartamento. */
const WEARABLE: Partial<Record<ItemType, keyof AvatarConfig>> = {
  hair: 'hair',
  top: 'top',
  bottom: 'bottom',
  shoes: 'shoes',
  accessory: 'accessory',
};

const SHOT_FOR: Partial<Record<ItemType, 'full' | 'bust' | 'legs' | 'feet'>> = {
  hair: 'bust', accessory: 'bust', top: 'bust',
  bottom: 'legs', shoes: 'feet',
};

const GLYPH: Partial<Record<ItemType, string>> = {
  furniture: '🛋️', floor: '🪵', wall: '🎨', decor: '🪴', stream_gear: '🎙️',
};

export function StoreView() {
  const wallet = useAccountStore((s) => s.wallet);
  const owned = useAccountStore((s) => s.owned);
  const avatar = useAccountStore((s) => s.avatar);
  const buy = useAccountStore((s) => s.buy);
  const wear = useAccountStore((s) => s.wear);
  const authenticated = useAccountStore((s) => Boolean(s.api?.authenticated));

  const tab = useShopStore((s) => s.tab);
  const setTab = useShopStore((s) => s.setTab);
  const currency = useShopStore((s) => s.currency);
  const setCurrency = useShopStore((s) => s.setCurrency);

  const [pending, setPending] = useState<{ item: ItemDef; currency: Currency } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const items = useMemo(() => shopItems(tab, currency), [tab, currency]);

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    const result = await buy(pending.item.id, pending.currency);
    setBusy(false);
    setPending(null);
    setToast({ ok: result.ok, text: result.message });
    window.setTimeout(() => setToast(null), 2600);
  };

  const dress = async (item: ItemDef) => {
    const slot = WEARABLE[item.type];
    if (!slot || !avatar) return;
    const result = await wear({ ...avatar, [slot]: item.id } as AvatarConfig);
    setToast({ ok: result.ok, text: result.message });
    window.setTimeout(() => setToast(null), 2600);
  };

  return (
    <section className="screen store">
      <header className="screen__head">
        <div>
          <h1 className="screen__title">Stream Store</h1>
          <p className="screen__sub">Roupa, cabelo, móveis e equipamento</p>
        </div>
        <div className="store__wallet">
          <Money currency="credits" amount={wallet.credits} icon={<IconCredits size={15} />} />
          <Money currency="coins" amount={wallet.coins} icon={<IconCoin size={15} />} />
        </div>
      </header>

      {!authenticated && (
        <Notice tone="warn">Entre com a sua conta para comprar — a loja precisa saber de quem é a carteira.</Notice>
      )}

      <div className="store__filters">
        <div className="store__tabs sp-scroll">
          {SHOP_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`store__tab${tab === t.id ? ' is-on' : ''}`}
              onClick={() => setTab(t.id as ShopTab)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Segmented
          value={currency}
          onChange={setCurrency}
          options={[
            { id: 'any', label: 'Tudo' },
            { id: 'credits', label: 'Credits' },
            { id: 'coins', label: 'Coins' },
          ]}
        />
      </div>

      <div className="store__grid">
        {items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            avatar={avatar}
            owned={owned.has(item.id)}
            onBuy={(c) => setPending({ item, currency: c })}
            onWear={() => void dress(item)}
          />
        ))}
      </div>

      {pending && (
        <div className="store__confirm" role="dialog" aria-label="Confirmar compra">
          <div className="store__confirmBox">
            <strong>{pending.item.name}</strong>
            <p>
              Comprar por{' '}
              <span className="sp-num">
                {short(priceOf(pending.item, pending.currency) ?? 0)}{' '}
                {pending.currency === 'coins' ? 'Coins' : 'Credits'}
              </span>
              ?
            </p>
            <div className="store__confirmActions">
              <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>Cancelar</Button>
              <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
                {busy ? 'Comprando…' : 'Confirmar'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`store__toast${toast.ok ? ' is-ok' : ' is-bad'}`} role="status">{toast.text}</div>
      )}
    </section>
  );
}

interface CardProps {
  item: ItemDef;
  avatar: AvatarConfig | null;
  owned: boolean;
  onBuy: (currency: Currency) => void;
  onWear: () => void;
}

function ItemCard({ item, avatar, owned, onBuy, onWear }: CardProps) {
  const slot = WEARABLE[item.type];
  // O avatar de quem está olhando, vestindo a peça. É o motivo de a loja
  // existir como tela em vez de lista.
  const preview = slot && avatar ? ({ ...avatar, [slot]: item.id } as AvatarConfig) : null;
  // Cada tipo no seu enquadramento. Calça em busto e tênis de corpo inteiro
  // eram cards que não mostravam a peça.
  const shot = SHOT_FOR[item.type] ?? 'bust';
  const poster = usePoster(preview, {
    shot,
    at: 1.5,
    width: 220,
    height: shot === 'legs' ? 300 : shot === 'feet' ? 200 : 240,
  });

  return (
    <article className={`item${owned ? ' is-owned' : ''}`}>
      <div className="item__art">
        {preview
          ? (poster
              ? <img src={poster} alt="" />
              : <span className="item__skeleton" aria-hidden />)
          : <span className="item__glyph" aria-hidden>{GLYPH[item.type] ?? '🎁'}</span>}
        {owned && <span className="item__owned"><IconCheck size={12} /> No armário</span>}
      </div>

      <div className="item__body">
        <div className="item__head">
          <h3 className="item__name">{item.name}</h3>
          <RarityTag rarity={item.rarity} />
        </div>

        <div className="item__buy">
          {owned ? (
            slot
              ? <Button size="sm" variant="secondary" icon={<IconBag size={14} />} onClick={onWear}>Vestir</Button>
              : <span className="item__note">Já é seu</span>
          ) : (
            <>
              {item.creditsPrice !== null && (
                <Button size="sm" variant="secondary" icon={<IconCredits size={14} />} onClick={() => onBuy('credits')}>
                  {item.creditsPrice === 0 ? 'Grátis' : short(item.creditsPrice)}
                </Button>
              )}
              {item.coinsPrice !== null && (
                <Button size="sm" variant="primary" icon={<IconCoin size={14} />} onClick={() => onBuy('coins')}>
                  {short(item.coinsPrice)}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function priceOf(item: ItemDef, currency: Currency): number | null {
  return currency === 'coins' ? item.coinsPrice : item.creditsPrice;
}

/** Catálogo é do shared; a loja não inventa item nenhum. */
export const CATALOG_SIZE = ITEM_BY_ID.size;
