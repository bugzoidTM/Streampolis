/**
 * Procedural portrait drawn from an `AvatarConfig`.
 *
 * The real thing is a render of the 3D head to an offscreen target.
 * TODO(game/avatar): expose `renderPortrait(config, size): HTMLCanvasElement`
 * from `game/avatar/Avatar.ts` and swap the <svg> for that canvas — the props
 * of this component are the interface it must satisfy.
 */
import type { AvatarConfig } from '@streampolis/shared';
import { HAIR_SWATCHES, SKIN_SWATCHES } from '../../state/avatarOptions.js';
import { ITEM_BY_ID } from '@streampolis/shared';
import './Portrait.css';

interface Props {
  config: AvatarConfig;
  size?: number;
  /** Ring colour, normally the sender's gifter tier. */
  ring?: string;
  /** Pulsing on-air ring. */
  live?: boolean;
  className?: string;
}

const TOP_COLORS: Record<string, string> = {
  top_tee_01: '#dfe4ee',
  top_hoodie_01: '#4a5a7d',
  top_jacket_01: '#8a4a2f',
  top_blazer_01: '#2b3145',
  top_holo_01: '#a56bff',
};

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Hair silhouettes. Kept blocky on purpose: it must read at 24 px. */
function hairShape(style: string, color: string) {
  switch (style) {
    case 'hair_buzz_01':
      return <path d="M13.6 20.4a10.4 10.4 0 0 1 20.8 0c0 1-.4 1.6-1.2 1.2-2-2.6-5.2-4-9.2-4s-7.2 1.4-9.2 4c-.8.4-1.2-.2-1.2-1.2z" fill={color} />;
    case 'hair_afro_01':
      return <circle cx="24" cy="19" r="13.4" fill={color} />;
    case 'hair_long_01':
      return (
        <>
          <path d="M10.6 40V21.6a13.4 13.4 0 0 1 26.8 0V40h-5.2V22.6c0-4.6-3.4-7.2-8.2-7.2s-8.2 2.6-8.2 7.2V40z" fill={color} />
          <path d="M11.4 20.6a12.6 12.6 0 0 1 25.2 0c0 1.6-.6 2.2-1.8 1.4-2.4-3.2-6-4.8-10.8-4.8s-8.4 1.6-10.8 4.8c-1.2.8-1.8.2-1.8-1.4z" fill={color} />
        </>
      );
    case 'hair_ponytail_01':
      return (
        <>
          <path d="M33 17.4c4.4 1.4 6.4 6 5 11.2-1 3.8-3 6-5.4 6.2l-1-5.2c1.6-.6 2.4-2.2 2.4-4.6z" fill={color} />
          <path d="M12.4 21a11.6 11.6 0 0 1 23.2 0c0 1.6-.6 2.2-1.8 1.4-2.2-3-5.6-4.6-9.8-4.6s-7.6 1.6-9.8 4.6c-1.2.8-1.8.2-1.8-1.4z" fill={color} />
        </>
      );
    case 'hair_braids_01':
      return (
        <>
          <path d="M12.6 21a11.4 11.4 0 0 1 22.8 0v2.6h-4V22c0-4.2-3-6.8-7.4-6.8S16.6 17.8 16.6 22v1.6h-4z" fill={color} />
          <rect x="11.4" y="22" width="4" height="16" rx="2" fill={color} />
          <rect x="32.6" y="22" width="4" height="16" rx="2" fill={color} />
        </>
      );
    case 'hair_mohawk_01':
      return (
        <>
          <path d="M14.4 22.6a9.6 9.6 0 0 1 19.2 0c0 .8-.4 1.2-1 .8-1.8-2-4.8-3.2-8.6-3.2s-6.8 1.2-8.6 3.2c-.6.4-1-.4-1-.8z" fill={color} opacity="0.5" />
          <path d="M21.2 8.6h5.6v12.2c0 .8-.6 1.2-1.4 1h-2.8c-.8.2-1.4-.2-1.4-1z" fill={color} />
        </>
      );
    default: // bob
      return (
        <path d="M11.8 30.4V21.4a12.2 12.2 0 0 1 24.4 0v9h-4.6v-8c0-4.4-3.2-7-7.6-7s-7.6 2.6-7.6 7v8z" fill={color} />
      );
  }
}

export function Portrait({ config, size = 40, ring, live, className }: Props) {
  const skin = SKIN_SWATCHES[config.skinTone % SKIN_SWATCHES.length];
  const hair = HAIR_SWATCHES[config.hairColor % HAIR_SWATCHES.length];
  const top = TOP_COLORS[config.top] ?? '#5c6784';
  const hue = hashHue(`${config.hair}${config.skinTone}${config.top}`);
  const showFace = size >= 30;

  return (
    <span
      className={`sp-portrait${live ? ' is-live' : ''}${className ? ` ${className}` : ''}`}
      style={{
        width: size, height: size,
        ['--sp-portrait-ring' as string]: ring ?? 'transparent',
        ['--sp-portrait-border' as string]: size >= 34 ? '2px' : '1.5px',
      }}
    >
      <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
        <defs>
          <clipPath id={`pc${hue}${config.skinTone}${size}`}>
            <circle cx="24" cy="24" r="24" />
          </clipPath>
          <linearGradient id={`pg${hue}${size}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={`hsl(${hue} 44% 30%)`} />
            <stop offset="1" stopColor={`hsl(${(hue + 40) % 360} 48% 16%)`} />
          </linearGradient>
        </defs>
        <g clipPath={`url(#pc${hue}${config.skinTone}${size})`}>
          <rect width="48" height="48" fill={`url(#pg${hue}${size})`} />
          <path d="M24 30c8.4 0 14.6 4.6 15.6 12.4L40 48H8l.4-5.6C9.4 34.6 15.6 30 24 30z" fill={top} />
          <rect x="20.4" y="26" width="7.2" height="8" rx="3.2" fill={skin} />
          <ellipse cx="24" cy="21.6" rx="9.4" ry="10.2" fill={skin} />
          {showFace && (
            <g fill="rgba(20,14,12,0.62)">
              <ellipse cx="20.4" cy="22" rx="1.15" ry="1.5" />
              <ellipse cx="27.6" cy="22" rx="1.15" ry="1.5" />
            </g>
          )}
          {hairShape(config.hair, hair)}
          {config.accessory === 'acc_halo_01' && (
            <ellipse cx="24" cy="8.4" rx="9" ry="2.6" fill="none" stroke="#ffd166" strokeWidth="1.8" />
          )}
          {config.accessory === 'acc_glasses_01' && (
            <g stroke="rgba(15,18,26,0.85)" strokeWidth="1.4" fill="none">
              <rect x="16.6" y="19.6" width="6" height="4.6" rx="1.6" />
              <rect x="25.4" y="19.6" width="6" height="4.6" rx="1.6" />
              <path d="M22.6 21.8h2.8" />
            </g>
          )}
        </g>
      </svg>
    </span>
  );
}

/** Small helper so lists can label an item chip without importing the catalog. */
export const itemName = (id: string): string => ITEM_BY_ID.get(id)?.name ?? id;
