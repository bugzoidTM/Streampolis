/**
 * Inline SVG icon set.
 *
 * Drawn by hand rather than pulled from a font or a package: the asset budget
 * (SPECs §44) has no room for an icon font, and emoji render differently on
 * every platform, which is exactly what a product UI cannot afford.
 *
 * All glyphs live on a 24x24 grid with a 1.7 stroke so they optically match at
 * the sizes the HUD uses (16–28 px).
 */
import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function svg(path: React.ReactNode, filled = false) {
  return function Icon({ size = 20, ...rest }: IconProps) {
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
        fill={filled ? 'currentColor' : 'none'}
        stroke={filled ? 'none' : 'currentColor'}
        strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
        {...rest}
      >
        {path}
      </svg>
    );
  };
}

export const IconMenu = svg(<><path d="M4 7h16M4 12h16M4 17h10" /></>);
export const IconClose = svg(<><path d="M6 6l12 12M18 6L6 18" /></>);
export const IconChevronDown = svg(<path d="M6 9.5l6 6 6-6" />);
export const IconChevronRight = svg(<path d="M9.5 6l6 6-6 6" />);
export const IconChevronLeft = svg(<path d="M14.5 6l-6 6 6 6" />);
export const IconSearch = svg(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>);
export const IconPlus = svg(<><path d="M12 5v14M5 12h14" /></>);
export const IconMinus = svg(<path d="M5 12h14" />);
export const IconCheck = svg(<path d="M4.5 12.5l5 5 10-11" />);

export const IconEye = svg(
  <>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.9" />
  </>,
);

export const IconChat = svg(
  <>
    <path d="M20.2 12.4c0 3.9-3.7 7-8.2 7-1 0-2-.15-2.9-.43L4 20.5l1.3-3.6C4.2 15.6 3.5 14.1 3.5 12.4c0-3.9 3.7-7 8.2-7s8.5 3.1 8.5 7z" />
  </>,
);

export const IconHeart = svg(
  <path d="M12 20.3S3.8 15.5 3.8 9.9c0-2.6 2-4.4 4.3-4.4 1.7 0 3.1 1 3.9 2.4.8-1.4 2.2-2.4 3.9-2.4 2.3 0 4.3 1.8 4.3 4.4 0 5.6-8.2 10.4-8.2 10.4z" />,
);
export const IconHeartFilled = svg(
  <path d="M12 20.3S3.8 15.5 3.8 9.9c0-2.6 2-4.4 4.3-4.4 1.7 0 3.1 1 3.9 2.4.8-1.4 2.2-2.4 3.9-2.4 2.3 0 4.3 1.8 4.3 4.4 0 5.6-8.2 10.4-8.2 10.4z" />,
  true,
);

/** A wrapped box with a ribbon — the gift catalog trigger. */
export const IconGift = svg(
  <>
    <path d="M4 11.2h16V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-7.8z" />
    <path d="M3 8.2h18v3H3z" />
    <path d="M12 8.2v12.3" />
    <path d="M12 8.2S10.9 3.5 8.4 3.5a2.3 2.3 0 0 0 0 4.7H12zM12 8.2s1.1-4.7 3.6-4.7a2.3 2.3 0 0 1 0 4.7H12z" />
  </>,
);

export const IconUser = svg(
  <>
    <circle cx="12" cy="8.4" r="3.6" />
    <path d="M4.8 20c.7-3.7 3.6-5.8 7.2-5.8s6.5 2.1 7.2 5.8" />
  </>,
);

export const IconBag = svg(
  <>
    <path d="M5 8h14l-1.1 11.2a1.5 1.5 0 0 1-1.5 1.3H7.6a1.5 1.5 0 0 1-1.5-1.3z" />
    <path d="M8.8 10.5V7.4a3.2 3.2 0 0 1 6.4 0v3.1" />
  </>,
);

export const IconTrophy = svg(
  <>
    <path d="M7.5 4h9v4.6a4.5 4.5 0 0 1-9 0z" />
    <path d="M7.5 5.6H5.2a2.6 2.6 0 0 0 2.6 4.6M16.5 5.6h2.3a2.6 2.6 0 0 1-2.6 4.6" />
    <path d="M12 13.1v3.6M8.6 20.2h6.8l-.7-3.5H9.3z" />
  </>,
);

export const IconSwords = svg(
  <>
    <path d="M14.6 4h4.7v4.7L11 17l-4.7-4.7z" />
    <path d="M4.4 19.6l3.1-3.1M9.4 4H4.7v4.7l2.4 2.4M14.9 16.5l2.4 2.4h2.3v-2.3l-2.4-2.4" />
  </>,
);

export const IconSparkle = svg(
  <>
    <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z" />
    <path d="M18.6 16.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" />
  </>,
);

export const IconFlame = svg(
  <path d="M12 20.5c3 0 5.3-2.1 5.3-5 0-3.6-3.4-5.3-3.4-9.1 0 0-2.6 1.2-2.6 4.2 0 1.6-1 2.2-1.7 1.3-.5-.6-.6-1.6-.6-1.6S6.7 12 6.7 15.5c0 2.9 2.3 5 5.3 5z" />,
);

export const IconCrown = svg(
  <>
    <path d="M4 8.2l3.2 3.1L12 5.2l4.8 6.1L20 8.2l-1.6 10H5.6z" />
    <path d="M5.6 20.5h12.8" />
  </>,
);

export const IconStar = svg(
  <path d="M12 4l2.4 5.1 5.6.7-4.1 3.9 1.1 5.5L12 16.5 6.9 19.2 8 13.7 3.9 9.8l5.6-.7z" />,
);

export const IconBolt = svg(<path d="M13.3 3L5.6 13.6h5.2l-.5 7.4 7.8-10.7h-5.2z" />);

export const IconCoin = svg(
  <>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M14.8 9.3a3.3 3.3 0 0 0-5.6 2.7 3.3 3.3 0 0 0 5.6 2.7" />
  </>,
);

export const IconCredits = svg(
  <>
    <rect x="3" y="6" width="18" height="12" rx="2.6" />
    <path d="M3 10.2h18M6.6 14.4h3.2" />
  </>,
);

export const IconShield = svg(
  <>
    <path d="M12 3.4l7 2.6v5.4c0 4.2-2.9 7.5-7 9.2-4.1-1.7-7-5-7-9.2V6z" />
    <path d="M9 12l2.2 2.2L15.4 10" />
  </>,
);

export const IconInfo = svg(
  <>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 11v5.2M12 7.9v.1" />
  </>,
);

export const IconLock = svg(
  <>
    <rect x="4.8" y="10.4" width="14.4" height="9.4" rx="2.2" />
    <path d="M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4" />
  </>,
);

export const IconArrowUp = svg(<><path d="M12 19V5M6 11l6-6 6 6" /></>);
export const IconArrowDown = svg(<><path d="M12 5v14M18 13l-6 6-6-6" /></>);
export const IconArrowLeft = svg(<><path d="M19 12H5M11 6l-6 6 6 6" /></>);

export const IconShare = svg(
  <>
    <path d="M12 15.5V4.2M8.2 7.7L12 4l3.8 3.7" />
    <path d="M5 13.4v5.1a1.9 1.9 0 0 0 1.9 1.9h10.2a1.9 1.9 0 0 0 1.9-1.9v-5.1" />
  </>,
);

export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="2.9" />
    <path d="M19.2 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1.1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.7-1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.6h-.3a1.8 1.8 0 1 1 0-3.6h.2a1.5 1.5 0 0 0 1-2.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 2.6-1.1v-.3a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 2.7 1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1.1 2.6h.3a1.8 1.8 0 1 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9z" />
  </>,
);

export const IconHome = svg(
  <>
    <path d="M4 10.6L12 4l8 6.6V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" />
    <path d="M9.6 20.5v-6h4.8v6" />
  </>,
);

export const IconBroadcast = svg(
  <>
    <circle cx="12" cy="12" r="2.4" />
    <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 15.8a5.4 5.4 0 0 0 0-7.6" />
    <path d="M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 18.6a9.3 9.3 0 0 0 0-13.2" />
  </>,
);

/* --- Camera framings (PRD §12). Each reads as a different crop. --- */
export const IconFrameDefault = svg(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <circle cx="12" cy="10.4" r="2.3" />
    <path d="M7.6 19.5c.7-2.8 2.3-4.3 4.4-4.3s3.7 1.5 4.4 4.3" />
  </>,
);
export const IconFrameClose = svg(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <circle cx="12" cy="11.6" r="4.6" />
  </>,
);
export const IconFrameFull = svg(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <circle cx="12" cy="8.3" r="1.5" />
    <path d="M12 10v4.4M9.6 11.4h4.8M10.2 18.4l1.8-4M13.8 18.4l-1.8-4" />
  </>,
);
export const IconFrameRoom = svg(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
    <path d="M3.5 15.6h17M8.2 15.6v-3.4h3.1v3.4M14 15.6v-5.2h2.7v5.2" />
  </>,
);

/*
 * Gestos (a barra de emotes).
 *
 * Desenhados aqui, e não com emoji, pelo motivo que abre este arquivo: emoji
 * renderiza diferente em cada plataforma — e nas que não têm a fonte, não
 * renderiza nada. A primeira versão desta barra usou emoji e saiu com seis
 * quadradinhos vazios na captura de prova.
 *
 * Todos são a mesma figura de traço: cabeça, tronco, dois braços, duas pernas.
 * A leitura vem da POSE, não do detalhe, porque a 20 px não há detalhe.
 */
export const IconStop = svg(<rect x="7" y="7" width="10" height="10" rx="2.2" />);
export const IconWave = svg(
  <>
    <circle cx="10.5" cy="4.6" r="2.1" />
    <path d="M10.5 6.9v7.2M10.5 9.4l-3 2.4M10.5 8.6l4.6-3.4M10.5 14.1l-2.4 6.3M10.5 14.1l2.6 6.3" />
    <path d="M17.6 3.2a4.6 4.6 0 011.1 3.1M19.8 1.6a7 7 0 011.5 4.6" />
  </>,
);
export const IconClap = svg(
  <>
    <rect x="3.4" y="9.6" width="5.4" height="10" rx="2.7" transform="rotate(-13 6.1 14.6)" />
    <rect x="15.2" y="9.6" width="5.4" height="10" rx="2.7" transform="rotate(13 17.9 14.6)" />
    <path d="M12 3.2v3.4M8.1 4.6l1.6 2.9M15.9 4.6l-1.6 2.9" />
  </>,
);
export const IconDance = svg(
  <>
    <circle cx="13.2" cy="4.4" r="2.1" />
    <path d="M13.2 6.7v6.4M13.2 8.9l4.4-3.1M13.2 10.1l-3.9 2.2M13.2 13.1l-3.3 7.3M13.2 13.1l3.6 7.3" />
  </>,
);
export const IconCelebrate = svg(
  <>
    <circle cx="12" cy="4.4" r="2.1" />
    <path d="M12 6.7v6.8M12 8.4L7.7 4.9M12 8.4l4.3-3.5M12 13.5l-2.9 6.9M12 13.5l2.9 6.9" />
  </>,
);
export const IconSit = svg(
  <>
    <circle cx="9.4" cy="4.8" r="2.1" />
    <path d="M9.4 7.1v6.2h6.1M15.5 13.3v6.4M9.4 13.3H6.2M6.2 9.6v10.1" />
  </>,
);
