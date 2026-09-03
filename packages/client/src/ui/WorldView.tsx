import { useEffect, useRef, useState } from 'react';
import type { AvatarConfig } from '@streampolis/shared';
import { World } from '../game/World.js';
import { BuildBar } from './BuildBar.js';
import { NetworkClient } from '../network/NetworkClient.js';
import { describeIntent, isLiveIntent, openWorld, type WorldIntent } from '../network/session.js';
import type { AnyWorldConnection } from '../network/WorldConnection.js';
import { useSessionStore } from '../state/useSessionStore.js';
import { LiveView } from './LiveView.js';
import { LoadingScreen } from './LoadingScreen.js';
import { WorldChat } from './chat/WorldChat.js';
import { EmoteBar } from './EmoteBar.js';
import { RosterPanel } from './RosterPanel.js';
import { PortalPrompt } from './PortalPrompt.js';
import type { LoadReport } from '../game/assets/loading.js';
import type { Portal } from '@streampolis/shared';

export interface WorldViewProps {
  /** O que o jogador quer fazer. Quem decide a sala é isto, não o World. */
  intent: WorldIntent;
  tier?: 'low' | 'medium' | 'high';
  token?: string;
  displayName?: string;
  avatar?: AvatarConfig;
  endpoint?: string;
  /** Uma tela cobre o mundo: pausa o laço em vez de desmontar a cena. */
  paused?: boolean;
  /**
   * Atravessar uma porta. Quem traduz destino em INTENÇÃO é a casca, que é
   * dona da navegação; aqui só se sabe que o jogador pisou no portal.
   */
  onTravel?: (portal: Portal) => void;
  /** Abrir o perfil de alguém que está na sala. */
  onOpenProfile?: (userId: string) => void;
}

/**
 * Monta o mundo 3D e a camada de live por cima dele.
 *
 * A ordem importa: conecta primeiro, desenha depois. A conexão diz em que sala
 * o jogador está e o World desenha ESSA sala — antes, o World abria uma
 * CityRoom por conta própria e uma live acabava acontecendo dentro da praça.
 *
 * React é dono do canvas e de mais nada: o laço de render vive no World e nunca
 * toca no estado de componente, senão uma praça cheia re-renderiza a UI
 * sessenta vezes por segundo.
 */
export function WorldView(props: WorldViewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<World | null>(null);
  // O World nasce dentro de um efeito; a barra precisa dele como ESTADO para
  // remontar quando ele fica pronto.
  const [ready, setReady] = useState<World | null>(null);
  const [status, setStatus] = useState<'loading' | 'online' | 'offline' | 'failed'>('loading');
  const [message, setMessage] = useState<string>(describeIntent(props.intent));
  const [inLive, setInLive] = useState(false);
  const [progress, setProgress] = useState<LoadReport | null>(null);
  const [portal, setPortal] = useState<Portal | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const session = useSessionStore.getState();
    let cancelled = false;
    let world: World | null = null;
    let connection: AnyWorldConnection | null = null;

    const run = async () => {
      setProgress({ phase: 'connect', label: describeIntent(props.intent), value: 0.02 });
      if (props.token && props.intent.kind !== 'offline') {
        try {
          // Só o token viaja: identidade e aparência são lidas dele no servidor
          // (SPECs §36, §68 regra 6).
          const client = new NetworkClient({ token: props.token }, props.endpoint);
          connection = await openWorld(client, props.intent);
          if (cancelled) { void connection.leave(); return; }
          session.attach(connection, props.intent.kind);
        } catch (err) {
          // Servidor fora do ar não pode apagar a tela: cai para o offline e a
          // UI diz o que aconteceu.
          console.warn('[world] não foi possível abrir a sala:', err);
          connection = null;
          session.goOffline(props.intent.kind);
          setMessage('Sem servidor de jogo — modo offline');
        }
      } else {
        session.goOffline('offline');
      }

      world = new World({
        canvas,
        connection,
        sceneId: props.intent.kind === 'offline' || props.intent.kind === 'city'
          ? props.intent.sceneId
          : undefined,
        tier: props.tier,
        displayName: props.displayName,
        avatar: props.avatar,
        onPortal: (p) => { if (!cancelled) setPortal(p); },
      });

      Object.assign(window as object, {
        __lab: {
          stats: () => world?.stats() ?? null,
          anim: (state: string | null) => world?.forceAnim(state as never),
          animReport: () => world?.animReport() ?? [],
          capture: () => world?.capture() ?? null,
          /** Dispara um presente sem economia; só para a revisão visual. */
          gift: (giftId: string, quantity = 1) => world?.previewGift(giftId, quantity) ?? false,
        },
        __world: world,
      });

      worldRef.current = world;
      world.setPaused(props.paused === true);
      await world.start((report) => { if (!cancelled) setProgress(report); });
      if (cancelled) return;
      setReady(world);
      // Sem servidor a pílula do canto precisa DIZER isso. Ela mostrava a
      // descrição da intenção ("Praça Central"), que não é aviso nenhum —
      // sobra do tempo em que esta mesma pílula também anunciava o
      // carregamento.
      if (!world.online) setMessage('Modo offline — sem servidor de jogo');
      setStatus(world.online ? 'online' : 'offline');
      setInLive(isLiveIntent(props.intent.kind) && world.online);
    };

    void run().catch((err) => {
      console.error('[world] falhou ao iniciar:', err);
      if (cancelled) return;
      useSessionStore.getState().fail('Não foi possível carregar a cena');
      setStatus('failed');
    });

    const onResize = () => world?.resize();
    window.addEventListener('resize', onResize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      useSessionStore.getState().detach();
      worldRef.current = null;
      setReady(null);
      world?.dispose();
    };
    // As props são lidas uma vez, na montagem, de propósito: reconectar no meio
    // da partida derrubaria a cena inteira.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pausar é barato e reversível; desmontar custaria reconstruir a cena inteira
  // e reconectar a sala só porque alguém abriu a loja por dez segundos.
  useEffect(() => {
    worldRef.current?.setPaused(props.paused === true);
  }, [props.paused]);

  return (
    <>
      <canvas
        ref={ref}
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block', background: '#0b0d12' }}
      />
      {/* Sai quando existe IMAGEM, não quando `start()` retorna: o mundo fica
          "pronto" alguns quadros antes de desenhar o primeiro deles, e sumir
          nesse intervalo devolve o jogador à tela preta. */}
      <LoadingScreen
        report={progress}
        done={progress?.phase === 'ready'}
        error={status === 'failed' ? 'Não foi possível carregar a cena' : null}
      />
      {inLive && <LiveView />}
      {/* Conversar é uma das cinco coisas que o PRD §6 pede da praça. Escondido
          dentro de uma live, que tem o chat dela: dois seria um dentro do
          outro, e os dois leem da mesma store. */}
      {/* `paused` é a casca dizendo que uma TELA cobre o mundo (feed, loja,
          perfil, criador de avatar). O chat pertence ao mundo: deixá-lo por
          cima da loja é uma barra de digitar flutuando sobre outra interface,
          e ele ainda rouba o Enter de quem está preenchendo um formulário. */}
      <WorldChat world={ready} hidden={inLive || props.paused === true || status === 'loading'} />

      {/* Saber QUEM está por perto é a primeira metade de "encontrar
          jogadores": sem isto, a única forma de descobrir era virar a câmera e
          ler as placas sobre as cabeças ao alcance. */}
      {props.onOpenProfile && (
        <RosterPanel
          onOpenProfile={props.onOpenProfile}
          hidden={props.paused === true || status === 'loading'}
        />
      )}

      {/* Gesticular é a outra metade de "encontrar jogadores": um mundo em que
          só se pode digitar não é um mundo social. Escondido enquanto uma tela
          cobre o mundo — os atalhos 1..6 pertencem ao jogo, não à loja. */}
      <EmoteBar world={ready} hidden={props.paused === true || status === 'loading'} />

      {/* "Acessar outros locais" é outra delas. Numa live não: quem está
          transmitindo não atravessa uma porta sem querer. */}
      {!inLive && !props.paused && props.onTravel && (
        <PortalPrompt portal={portal} onEnter={props.onTravel} />
      )}
      {/* A barra decide sozinha se a casa é do jogador; visitante vê a
          mobília do anfitrião e nenhuma alça. */}
      <BuildBar
        world={ready}
        apartmentId={props.intent.kind === 'apartment' && !inLive ? ready?.apartmentId ?? null : null}
      />
      {/* A pílula do canto não fala mais de carregamento: quem faz isso é a
          tela cheia. Ela volta a ser só o que sempre deveria ter sido — o
          aviso de que a partida está sem servidor. */}
      {status === 'offline' && (
        <div className="world-status" role="status">{message}</div>
      )}
    </>
  );
}
