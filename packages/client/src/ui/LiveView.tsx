import { useEffect, useMemo, useRef, useState } from 'react';
import { GIFT_CATALOG, gifterTierFor, type GiftDef } from '@streampolis/shared';
import { useChatStore } from '../state/useChatStore.js';
import { useLiveStore } from '../state/useLiveStore.js';
import { useSessionStore } from '../state/useSessionStore.js';
import { short } from '../state/format.js';
import { Button, GifterBadge, IconButton, LiveDot } from './primitives/Controls.js';
import { Portrait } from './primitives/Portrait.js';
import {
  IconChat, IconClose, IconCoin, IconEye, IconGift, IconHeartFilled, IconSwords,
} from './Icons.js';
import './live.css';

/**
 * A tela da live (PRD §10, §12).
 *
 * É a tela que prova a ideia do produto: alguém transmite, alguém assiste,
 * alguém manda um presente e todo mundo vê. Tudo aqui é leitura do estado do
 * servidor — espectadores, curtidas, placar de PK — e escrita por INTENÇÃO:
 * o botão manda `gift`, nunca "some 99 moedas". Quem cobra é a API; quem
 * confirma é a sala; esta camada só pede e desenha o que voltou.
 */

const QUANTITIES = [1, 10, 99] as const;

export function LiveView() {
  const room = useLiveStore((s) => s.room);
  const pk = useLiveStore((s) => s.pk);
  const likes = useLiveStore((s) => s.likes);
  const connection = useSessionStore((s) => s.connection);
  const [tray, setTray] = useState(false);
  const [quantity, setQuantity] = useState<number>(1);
  const [hearts, setHearts] = useState<number[]>([]);

  const onLike = () => {
    connection?.like(1);
    // A explosão de corações é local e imediata; o total é o do servidor, que
    // agrega e devolve (SPECs §32). Nunca somamos no cliente.
    const id = Date.now() + Math.random();
    setHearts((h) => [...h.slice(-14), id]);
    window.setTimeout(() => setHearts((h) => h.filter((x) => x !== id)), 1400);
  };

  const onGift = (gift: GiftDef) => {
    connection?.gift(gift.id, quantity);
    setTray(false);
  };

  if (!room) return null;

  return (
    <div className="live">
      <header className="live__top">
        <div className="live__host">
          <Portrait config={{ ...DEFAULT_LOOK }} size={40} live ring="var(--sp-live)" />
          <div className="live__hostText">
            <div className="live__hostName">
              <strong>{room.hostName || 'Host'}</strong>
              <LiveDot />
            </div>
            <div className="live__title">{room.title}</div>
          </div>
        </div>

        <div className="live__counts">
          <span className="live__count" title="Espectadores agora">
            <IconEye size={16} /> <span className="sp-num">{short(room.viewers)}</span>
          </span>
          <span className="live__count" title="Curtidas">
            <IconHeartFilled size={16} /> <span className="sp-num">{short(likes)}</span>
          </span>
          {room.role === 'host' && (
            <Button
              variant="danger" size="sm"
              onClick={() => connection?.endLive()}
            >
              Encerrar
            </Button>
          )}
        </div>
      </header>

      {pk && (
        <div className="live__pk">
          <span className="live__pkSide live__pkSide--a">
            <span className="live__pkName">{pk.a.streamer.name}</span>
            <span className="sp-num">{short(pk.a.score)}</span>
          </span>
          <span className="live__pkBar">
            <span
              className="live__pkFill"
              style={{ width: `${pkShare(pk.a.score, pk.b.score)}%` }}
            />
            <IconSwords size={14} />
          </span>
          <span className="live__pkSide live__pkSide--b">
            <span className="sp-num">{short(pk.b.score)}</span>
            <span className="live__pkName">{pk.b.streamer.name}</span>
          </span>
        </div>
      )}

      <ChatColumn />

      <div className="live__actions">
        {hearts.map((id) => (
          <span key={id} className="live__heart" aria-hidden>
            <IconHeartFilled size={22} />
          </span>
        ))}
        <IconButton label="Curtir" variant="ghost" size="lg" onClick={onLike}>
          <IconHeartFilled size={22} />
        </IconButton>
        <IconButton
          label="Presentear" variant="live" size="lg"
          onClick={() => setTray((v) => !v)}
        >
          <IconGift size={22} />
        </IconButton>
      </div>

      {tray && (
        <div className="live__tray" role="dialog" aria-label="Presentes">
          <div className="live__trayHead">
            <strong>Presentes</strong>
            <div className="live__qty">
              {QUANTITIES.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`live__qtyBtn${quantity === q ? ' is-on' : ''}`}
                  onClick={() => setQuantity(q)}
                >
                  x{q}
                </button>
              ))}
            </div>
            <IconButton label="Fechar" size="sm" onClick={() => setTray(false)}>
              <IconClose size={16} />
            </IconButton>
          </div>
          <div className="live__gifts">
            {GIFT_CATALOG.filter((g) => g.active).map((gift) => (
              <button
                key={gift.id}
                type="button"
                className="live__gift"
                style={{ '--gift': gift.color } as React.CSSProperties}
                onClick={() => onGift(gift)}
              >
                <span className="live__giftGlyph" aria-hidden>{GLYPHS[gift.id] ?? '🎁'}</span>
                <span className="live__giftName">{gift.name}</span>
                <span className="live__giftCost sp-num">
                  <IconCoin size={12} /> {short(gift.coinCost * quantity)}
                </span>
              </button>
            ))}
          </div>
          <p className="live__trayNote">
            O servidor cobra e só então o efeito aparece. Saldo insuficiente vira
            um aviso no chat, não uma animação.
          </p>
        </div>
      )}

      {room.ended && (
        <div className="live__ended" role="status">
          <strong>Esta live terminou.</strong>
        </div>
      )}
    </div>
  );
}

/** Chat da live: histórico rolando e o compositor embaixo. */
function ChatColumn() {
  const messages = useChatStore((s) => s.messages);
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const send = useChatStore((s) => s.send);
  const open = useLiveStore((s) => s.room) !== null;
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Rola sozinho só quando já estava no fim: puxar o histórico para ler algo e
  // ser arrastado de volta a cada mensagem nova é o defeito clássico de chat.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const visible = useMemo(() => messages.slice(-60), [messages]);
  if (!open) return null;

  return (
    <div className={`live__chat${collapsed ? ' is-collapsed' : ''}`}>
      <div className="live__chatBar">
        <IconButton
          label={collapsed ? 'Mostrar chat' : 'Esconder chat'}
          size="sm"
          onClick={() => setCollapsed((v) => !v)}
        >
          <IconChat size={16} />
        </IconButton>
      </div>

      {!collapsed && (
        <>
          <div className="live__messages sp-scroll" ref={listRef}>
            {visible.map((m) => (
              <div key={m.id} className={`live__msg live__msg--${m.kind}`}>
                {m.sender && (
                  <>
                    <GifterBadge xp={m.sender.gifterXp} size="sm" compact />
                    <span
                      className="live__msgName"
                      style={{ color: gifterTierFor(m.sender.gifterXp).color }}
                    >
                      {m.sender.name}
                    </span>
                  </>
                )}
                <span className="live__msgText">{m.text}</span>
              </div>
            ))}
          </div>

          <form
            className="live__composer"
            onSubmit={(e) => { e.preventDefault(); send(); }}
          >
            <input
              className="live__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Diga alguma coisa…"
              maxLength={200}
              aria-label="Mensagem"
            />
            <Button variant="primary" size="sm" onClick={() => send()}>Enviar</Button>
          </form>
        </>
      )}
    </div>
  );
}

function pkShare(a: number, b: number): number {
  const total = a + b;
  if (total <= 0) return 50;
  return Math.round((a / total) * 100);
}

/** Glifos do catálogo. Placeholder honesto até os ícones de verdade. */
const GLYPHS: Record<string, string> = {
  g_rose: '🌹', g_coffee: '☕', g_heart: '❤️', g_star: '⭐',
  g_diamond: '💎', g_crown: '👑', g_rocket: '🚀',
};

/** O host ainda não expõe a aparência ao espectador; o retrato usa o padrão. */
const DEFAULT_LOOK = {
  bodyPreset: 0, skinTone: 3, facePreset: 0, hair: 'hair_bob_01', hairColor: 1,
  top: 'top_tee_01', bottom: 'bottom_jeans_01', shoes: 'shoes_sneaker_01',
  accessory: '', height: 1,
};
