import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../network/api.js';
import { useAccountStore } from '../state/useAccountStore.js';
import { useGigStore } from '../state/useGigStore.js';
import { Button, Money, Notice, SheetHeader } from './primitives/Controls.js';
import { IconBolt, IconCheck, IconCredits, IconFlame, IconInfo } from './Icons.js';

/**
 * Bicos de rua (PRD §26): o quadro de ofertas do Distrito Sombra.
 *
 * O §26 pede quatro trabalhos no MVP e só um existia — tarefas diárias, que se
 * cumprem sozinhas enquanto a pessoa vive na cidade. Este é o outro tipo: você
 * escolhe, o relógio corre, e o pagamento depende de você chegar.
 *
 * ## O que esta tela NÃO faz
 *
 * Não confirma chegada, não conta parada e não soma Credits. Ela aceita e larga
 * — dois botões. Quem vê a chegada é a sala (tem a posição), quem decide se ela
 * conta é a API (tem a ordem e o prazo), e o resultado volta pelo `gigUpdate`.
 * Uma tela que marcasse a parada ao clicar seria um jogo em que a entrega se
 * faz de casa.
 *
 * ## A ATENÇÃO é mostrada como troca, não como castigo
 *
 * O nível aparece com as duas metades juntas — "paga mais, dá menos tempo" —
 * porque é isso que ele é. Uma barra vermelha subindo, sem dizer o que faz, é
 * lida como ameaça, e o §9 é explícito sobre não punir. O texto também diz que
 * ela CAI sozinha: sem isso, um jogador com 4 estrelas acha que estragou a
 * conta.
 */

function minutos(segundos: number): string {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return m > 0 ? `${m}min${s > 0 ? ` ${s}s` : ''}` : `${s}s`;
}

/** As estrelas de atenção, desenhadas — nunca emoji (ver o briefing). */
function Atencao({ level, max }: { level: number; max: number }) {
  return (
    <span className="gig__heat" aria-label={`Atenção nível ${level} de ${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <IconFlame
          key={i}
          size={15}
          className={i < level ? 'gig__flame is-on' : 'gig__flame'}
        />
      ))}
    </span>
  );
}

export interface GigPanelProps {
  onClose: () => void;
  /**
   * Avisa a sala para reler a corrida na API.
   *
   * Passado de fora porque a conexão é do mundo, não da tela. Sem este aviso,
   * quem aceita um bico só passa a ser seguido ao sair e voltar ao bairro — e o
   * sintoma seria o pior possível: andar até a parada e nada acontecer.
   */
  onSync: () => void;
}

export function GigPanel({ onClose, onSync }: GigPanelProps) {
  const api = useAccountStore((s) => s.api);
  const refresh = useAccountStore((s) => s.refresh);
  const board = useGigStore((s) => s.board);
  const run = useGigStore((s) => s.run);
  const setBoard = useGigStore((s) => s.setBoard);
  const setRun = useGigStore((s) => s.setRun);

  const [ocupado, setOcupado] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!api) return;
    try {
      setBoard(await api.gigs());
    } catch {
      // Sem quadro a tela mostra o vazio; um bico não é caminho crítico.
    }
  }, [api, setBoard]);

  useEffect(() => { void carregar(); }, [carregar]);

  const aceitar = async (gigId: string) => {
    if (!api) return;
    setOcupado(gigId);
    setErro(null);
    try {
      const { run: nova } = await api.acceptGig(gigId);
      setRun(nova);
      onSync();
      onClose();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Não deu para aceitar agora.');
      // O quadro pode ter mudado por baixo (uma corrida que venceu, por
      // exemplo). Reler é mais barato que adivinhar qual era o estado.
      void carregar();
    } finally {
      setOcupado(null);
    }
  };

  const largar = async () => {
    if (!api) return;
    setOcupado('largar');
    try {
      await api.abandonGig();
      setRun(null);
      onSync();
      await carregar();
      // O saldo não muda ao largar, mas a carteira pode ter mudado por outro
      // caminho enquanto o painel estava aberto.
      void refresh();
    } finally {
      setOcupado(null);
    }
  };

  return (
    <div className="gig">
      <SheetHeader
        title="Bicos de rua"
        subtitle="Trabalho pago no Distrito Sombra. Chegue nas paradas, na ordem, dentro do tempo."
        onClose={onClose}
      />

      {board && (
        <div className="gig__status">
          <div className="gig__statusrow">
            <Atencao level={board.heat} max={board.heatMax} />
            <span className="gig__statustext">
              {board.heat === 0
                ? 'O bairro ainda não reparou em você.'
                : `Atenção ${board.heat}: paga mais, dá menos tempo.`}
            </span>
          </div>
          <p className="gig__statushint">
            {board.toNextLevel === null
              ? `No máximo. Cai sozinha depois de ${board.windowHours}h sem entregas.`
              : `${board.toNextLevel} ${board.toNextLevel === 1 ? 'entrega' : 'entregas'} para o próximo nível. `
                + `Ela cai sozinha: só contam as últimas ${board.windowHours}h.`}
          </p>
        </div>
      )}

      {erro && <Notice tone="warn" icon={<IconInfo size={15} />}>{erro}</Notice>}

      {run && (
        <div className="gig__active">
          <div className="gig__activetop">
            <span className="gig__activetitle">{run.title}</span>
            <Money currency="credits" amount={run.credits} icon={<IconCredits size={14} />} />
          </div>
          <ol className="gig__stops">
            {run.stops.map((s, i) => (
              <li key={`${s.id}-${i}`} className={s.done ? 'gig__stop is-done' : 'gig__stop'}>
                {s.done ? <IconCheck size={14} /> : <span className="gig__stopnum">{i + 1}</span>}
                <span>{s.label}</span>
              </li>
            ))}
          </ol>
          <Button variant="ghost" onClick={largar} disabled={ocupado !== null}>
            Largar este bico
          </Button>
        </div>
      )}

      <ul className="gig__offers">
        {(board?.offers ?? []).map((o) => (
          <li key={o.id} className="gig__offer">
            <div className="gig__offertext">
              <span className="gig__offertitle">{o.title}</span>
              <p className="gig__offerflavor">{o.flavor}</p>
              <span className="gig__offermeta">
                {o.stops} paradas · {minutos(o.seconds)}
              </span>
            </div>
            <div className="gig__offerside">
              <Money currency="credits" amount={o.credits} icon={<IconCredits size={14} />} />
              <Button
                variant="primary"
                icon={<IconBolt size={15} />}
                onClick={() => aceitar(o.id)}
                // Um bico por vez é regra do BANCO (índice parcial); o botão
                // desligado só evita o pedido que já se sabe que será recusado.
                disabled={ocupado !== null || run !== null}
              >
                {ocupado === o.id ? 'Aceitando…' : 'Aceitar'}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
