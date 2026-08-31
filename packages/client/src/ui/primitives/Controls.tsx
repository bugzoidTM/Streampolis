import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { GIFTER_TIERS, gifterTierFor, type Rarity } from '@streampolis/shared';
import { IconClose } from '../Icons.js';
import './controls.css';

/* ------------------------------------------------------------------ button */

type Variant = 'primary' | 'secondary' | 'ghost' | 'live' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** Stretches to the container; used for the sticky mobile actions. */
  block?: boolean;
}

export function Button({
  variant = 'secondary', size = 'md', icon, block, className, children, ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`sp-btn sp-btn--${variant} sp-btn--${size}${block ? ' is-block' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {icon && <span className="sp-btn__icon">{icon}</span>}
      {children != null && <span className="sp-btn__label">{children}</span>}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: Variant;
  size?: Size;
  /** Small count bubble, e.g. unread chat. */
  badge?: string;
}

export function IconButton({
  label, variant = 'ghost', size = 'md', badge, className, children, ...rest
}: IconButtonProps) {
  return (
    <button
      type="button" aria-label={label} title={label}
      className={`sp-iconbtn sp-btn--${variant} sp-iconbtn--${size}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
      {badge && <span className="sp-iconbtn__badge sp-num">{badge}</span>}
    </button>
  );
}

/* -------------------------------------------------------------- segmented */

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** Horizontal scroll instead of wrapping — used by long filter rows. */
  scroll?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  options, value, onChange, scroll, size = 'md', ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist" aria-label={ariaLabel}
      className={`sp-seg sp-seg--${size}${scroll ? ' is-scroll sp-scroll' : ''}`}
    >
      {options.map((o) => (
        <button
          key={o.id} role="tab" type="button"
          aria-selected={o.id === value}
          className={`sp-seg__item${o.id === value ? ' is-on' : ''}`}
          onClick={() => onChange(o.id)}
        >
          {o.icon && <span className="sp-seg__icon">{o.icon}</span>}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ meter */

interface MeterProps {
  label: string;
  value: number;
  color: string;
  icon?: ReactNode;
  /** Compact mode drops the numeric read-out on narrow HUDs. */
  compact?: boolean;
}

/** A need bar (PRD §9). Turns amber below 30 so the player notices without a modal. */
export function Meter({ label, value, color, icon, compact }: MeterProps) {
  const low = value < 30;
  return (
    <div className={`sp-meter${low ? ' is-low' : ''}`} title={`${label}: ${Math.round(value)}%`}>
      {icon && <span className="sp-meter__icon" style={{ color }}>{icon}</span>}
      <div className="sp-meter__body">
        {!compact && (
          <div className="sp-meter__top">
            <span className="sp-meter__label">{label}</span>
            <span className="sp-meter__value sp-num">{Math.round(value)}</span>
          </div>
        )}
        <div className="sp-meter__track">
          <div
            className="sp-meter__fill"
            style={{ width: `${Math.max(2, Math.min(100, value))}%`, background: color }}
          />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- currency */

interface MoneyProps {
  currency: 'credits' | 'coins';
  amount: string | number;
  icon?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Shows a `+` affordance, used in the HUD wallet. */
  onTopUp?: () => void;
}

export function Money({ currency, amount, icon, size = 'md', onTopUp }: MoneyProps) {
  return (
    <div className={`sp-money sp-money--${currency} sp-money--${size}`}>
      {icon && <span className="sp-money__icon">{icon}</span>}
      <span className="sp-money__amount sp-num">{amount}</span>
      <span className="sp-money__unit">{currency === 'coins' ? 'Coins' : 'Credits'}</span>
      {onTopUp && (
        <button type="button" className="sp-money__topup" onClick={onTopUp} aria-label={`Comprar ${currency === 'coins' ? 'Coins' : 'Credits'}`}>+</button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- gifter badge */

interface GifterBadgeProps {
  xp: number;
  size?: 'xs' | 'sm' | 'md';
  /** Hides the label and keeps only the level chip, for dense chat rows. */
  compact?: boolean;
}

/** Gifter Prestige badge (PRD §17). Colour and name both come from shared. */
export function GifterBadge({ xp, size = 'sm', compact }: GifterBadgeProps) {
  const tier = gifterTierFor(xp);
  const next = GIFTER_TIERS[Math.min(tier.level + 1, GIFTER_TIERS.length - 1)];
  const hint = tier.level === GIFTER_TIERS.length - 1
    ? `${tier.name} — nível máximo`
    : `${tier.name} · faltam ${(next.xp - xp).toLocaleString('pt-BR')} XP para ${next.name}`;
  return (
    <span
      className={`sp-gifter sp-gifter--${size}${compact ? ' is-compact' : ''}`}
      style={{ ['--sp-tier' as string]: tier.color }}
      title={hint}
    >
      <span className="sp-gifter__lv sp-num">{tier.level}</span>
      {!compact && <span className="sp-gifter__name">{tier.name}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ misc */

const RARITY_LABEL: Record<Rarity, string> = {
  common: 'Comum', rare: 'Raro', epic: 'Épico', legendary: 'Lendário', mythic: 'Mítico',
};

export function RarityTag({ rarity }: { rarity: Rarity }) {
  return <span className={`sp-rarity sp-rarity--${rarity}`}>{RARITY_LABEL[rarity]}</span>;
}

export function LiveDot({ label = 'AO VIVO' }: { label?: string }) {
  return (
    <span className="sp-livedot">
      <i />
      {label}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="sp-stat">
      <div className="sp-stat__value sp-num">{value}</div>
      <div className="sp-stat__label">{label}</div>
      {hint && <div className="sp-stat__hint">{hint}</div>}
    </div>
  );
}

export function Panel({
  title, action, children, className, dense,
}: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; dense?: boolean }) {
  return (
    <section className={`sp-panel${dense ? ' is-dense' : ''}${className ? ` ${className}` : ''}`}>
      {(title || action) && (
        <header className="sp-panel__head">
          <h2 className="sp-panel__title">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function SheetHeader({
  title, subtitle, onClose, right,
}: { title: ReactNode; subtitle?: ReactNode; onClose?: () => void; right?: ReactNode }) {
  return (
    <header className="sp-sheethead">
      <div className="sp-sheethead__text">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {right}
      {onClose && (
        <IconButton label="Fechar" onClick={onClose} className="sp-sheethead__close">
          <IconClose size={20} />
        </IconButton>
      )}
    </header>
  );
}

export function Notice({ tone = 'info', icon, children }: { tone?: 'info' | 'warn'; icon?: ReactNode; children: ReactNode }) {
  return (
    <p className={`sp-notice sp-notice--${tone}`}>
      {icon && <span className="sp-notice__icon">{icon}</span>}
      <span>{children}</span>
    </p>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="sp-empty">
      {icon && <span className="sp-empty__icon">{icon}</span>}
      <p className="sp-empty__title">{title}</p>
      {hint && <p className="sp-empty__hint">{hint}</p>}
    </div>
  );
}
