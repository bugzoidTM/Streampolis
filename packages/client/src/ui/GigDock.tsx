import { useEffect, useState } from 'react';
import type { World } from '../game/World.js';
import { useAccountStore } from '../state/useAccountStore.js';
import { useGigStore } from '../state/useGigStore.js';
import { GigPanel } from './GigPanel.js';
import { GigTracker } from './GigTracker.js';
import { Button } from './primitives/Controls.js';
import { IconBolt } from './Icons.js';
import './gig.css';

/**
 * A costura dos bicos (PRD §26): o que liga a API, a sala e o mundo 3D.
 *
 * Um componente só para isso, e não três pedaços espalhados, porque as quatro
 * pontas de um bico precisam concordar quadro a quadro:
 *
 *   * a **API** diz qual é a corrida e a parada da vez (`GET /me/gigs`);
 *   * a **sala** avisa quando o jogador chega numa parada (`MSG.gigUpdate`) —
 *     ela é a única que vê a posição;
 *   * o **mundo 3D** desenha o pilar de luz na parada (`World.setGigTarget`);
 *   * a **tela** mostra o relógio e o quanto falta.
 *
 * Enquanto isso estivesse dentro do painel, o marcador no mundo só existiria
 * com o painel aberto — e o painel é justamente o que se fecha para poder
 * andar.
 *
 * ## Por que ele só existe no bairro
 *
 * `active` vem da CENA em que o mundo está, não da intenção da URL. Fora do
 * Distrito Sombra a faixa mostraria uma parada a sessenta metros, atrás de uma
 * porta, e o botão abriria um quadro de ofertas que não dá para cumprir dali.
 */

export interface GigDockProps {
  world: World | null;
  active: boolean;
}

export function GigDock({ world, active }: GigDockProps) {
  const api = useAccountStore((s) => s.api);
  const refresh = useAccountStore((s) => s.refresh);
  const setBoard = useGigStore((s) => s.setBoard);
  const setRun = useGigStore((s) => s.setRun);
  const markPaid = useGigStore((s) => s.markPaid);
  const limpar = useGigStore((s) => s.clear);
  const run = useGigStore((s) => s.run);

  const [aberto, setAberto] = useState(false);

  // O quadro é lido ao entrar no bairro. Quem chega já correndo um bico —
  // aceitou, saiu para a praça e voltou — reencontra a corrida onde parou:
  // ela é da API e sobrevive a trocar de sala e a recarregar a página.
  useEffect(() => {
    if (!active || !api) return;
    let vivo = true;
    void api.gigs()
      .then((board) => { if (vivo) setBoard(board); })
      .catch(() => { /* bico não é caminho crítico: o bairro abre sem ele */ });
    return () => { vivo = false; };
  }, [active, api, setBoard]);

  /**
   * A chegada, vinda da sala.
   *
   * O `credits` e o saldo vêm da API dentro da mesma mensagem — a tela não soma
   * nada. Depois de uma entrega o quadro é relido porque o NÍVEL DE ATENÇÃO
   * mudou, e ele muda o pagamento de todas as ofertas.
   */
  useEffect(() => {
    const link = world?.link;
    if (!link || !active) return;
    return link.on('gigUpdate', (update) => {
      if (!update.accepted) return;
      if (update.delivered) {
        markPaid(update.credits);
        setRun(null);
        void refresh();
        void api?.gigs().then(setBoard).catch(() => {});
        return;
      }
      /**
       * Avanço de parada: a corrida continua, só mudou o destino.
       *
       * A mensagem da sala é mais MAGRA que a corrida — ela não repete título,
       * pagamento nem a lista de paradas, e repetir seria mandar a mesma coisa
       * a cada chegada. Então o que se aplica aqui é a diferença, sobre a
       * corrida que já estava na mão. Sem uma corrida anterior não há o que
       * remendar, e a resposta certa é reler o quadro inteiro.
       */
      const atual = useGigStore.getState().run;
      const adiante = update.run;
      if (!adiante) { setRun(null); return; }
      if (!atual) {
        void api?.gigs().then(setBoard).catch(() => {});
        return;
      }
      setRun({
        ...atual,
        stopsDone: adiante.stopsDone,
        deadlineAt: adiante.deadlineAt,
        stops: atual.stops.map((s, i) => ({ ...s, done: i < adiante.stopsDone })),
        next: adiante.next ? { ...adiante.next, done: false } : null,
      });
    });
  }, [world, active, api, markPaid, setRun, setBoard, refresh]);

  // O pilar de luz na parada da vez. `null` quando não há corrida — inclusive
  // ao sair do bairro, senão o marcador ficaria plantado na praça.
  useEffect(() => {
    world?.setGigTarget(active && run?.next ? { x: run.next.x, z: run.next.z } : null);
  }, [world, active, run]);

  // Sair do bairro esvazia o estado: uma corrida mostrada fora do lugar onde
  // ela acontece é um relógio correndo sem nada a fazer a respeito.
  useEffect(() => {
    if (!active) limpar();
  }, [active, limpar]);

  if (!active) return null;

  return (
    <>
      <GigTracker />
      {!aberto && (
        <div className="gigdock">
          <Button
            variant={run ? 'secondary' : 'primary'}
            icon={<IconBolt size={16} />}
            onClick={() => setAberto(true)}
          >
            {run ? 'Bico' : 'Bicos de rua'}
          </Button>
        </div>
      )}
      {aberto && (
        <div className="gigsheet">
          <GigPanel
            onClose={() => setAberto(false)}
            onSync={() => world?.link?.gigSync()}
          />
        </div>
      )}
    </>
  );
}
