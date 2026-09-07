import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Mission, type MissionsView } from '../network/api.js';
import { useAccountStore } from '../state/useAccountStore.js';
import { Button, Money, Notice } from './primitives/Controls.js';
import { IconCheck, IconCredits, IconSparkle } from './Icons.js';

/**
 * Missões (PRD §24).
 *
 * A volta guiada (`OnboardingCard`) continua sendo o MAPA da primeira sessão:
 * ela mostra só o próximo passo e some quando termina. Este painel é a outra
 * coisa — a lista inteira, com o que cada uma paga e o botão de resgatar.
 *
 * Três decisões:
 *
 * - **A recompensa não some depois de resgatada.** A linha fica lá, marcada,
 *   com o valor que pagou. Uma lista que apaga o que já foi feito rouba a única
 *   sensação de progresso que ela tinha para dar;
 * - **o que ainda não foi cumprido mostra a DICA, não um botão.** O botão que
 *   levaria a pessoa até lá é o da volta guiada; repetir aqui seria dois
 *   caminhos para o mesmo lugar, cada um com a sua chance de discordar do
 *   outro;
 * - **o painel recarrega depois de resgatar**, porque o saldo e o estado vêm do
 *   servidor. Somar 50 Credits na tela seria o cliente calculando dinheiro.
 */

export interface MissionsPanelProps {
  onClose: () => void;
}

export function MissionsPanel({ onClose }: MissionsPanelProps) {
  const api = useAccountStore((s) => s.api);
  const refresh = useAccountStore((s) => s.refresh);
  const wallet = useAccountStore((s) => s.wallet);

  const [dados, setDados] = useState<MissionsView | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [recado, setRecado] = useState<{ ok: boolean; texto: string } | null>(null);

  const recarregar = useCallback(async () => {
    if (!api?.authenticated) return;
    try {
      setDados(await api.missions());
    } catch {
      setRecado({ ok: false, texto: 'Não foi possível carregar as missões agora.' });
    }
  }, [api]);

  useEffect(() => { void recarregar(); }, [recarregar]);

  const resgatar = async (m: Mission) => {
    setOcupado(m.id);
    try {
      const r = await api!.claimMission(m.id);
      await Promise.all([recarregar(), refresh()]);
      setRecado({
        ok: true,
        texto: r.replayed ? 'Esta já tinha sido resgatada.' : `+${r.credits} Credits e +${r.xp} XP.`,
      });
    } catch (err) {
      setRecado({ ok: false, texto: err instanceof ApiError ? err.message : 'Não deu certo agora.' });
    } finally {
      setOcupado(null);
      window.setTimeout(() => setRecado(null), 3000);
    }
  };

  return (
    <div className="store__confirm" role="dialog" aria-label="Missões">
      <div className="store__confirmBox agency">
        <header className="agency__head">
          <strong><IconSparkle size={15} /> Missões</strong>
          <Money currency="credits" amount={wallet.credits} icon={<IconCredits size={15} />} />
        </header>

        {!dados && <p className="coinshop__hint">Carregando…</p>}

        {dados && (
          <>
            <p className="coinshop__hint">
              {dados.completed} de {dados.total} cumpridas
              {dados.claimable > 0 && ` · ${dados.claimable} para resgatar`}
            </p>
            {dados.claimable === 0 && dados.completed === dados.total && (
              <Notice tone="info">Você fez tudo o que a cidade tinha para ensinar.</Notice>
            )}

            <ul className="coinshop__list">
              {dados.missions.map((m) => (
                <li key={m.id} className={`coinshop__pack mission${m.done ? ' is-done' : ''}`}>
                  <div className="coinshop__packInfo">
                    <span className="coinshop__packName">
                      {m.claimed && <span className="mission__check" aria-hidden><IconCheck size={12} /></span>}
                      {m.title}
                    </span>
                    <span className="coinshop__packCoins">
                      {m.claimed ? 'resgatada' : m.done ? 'pronta para resgatar' : m.hint}
                    </span>
                  </div>
                  <div className="mission__reward">
                    <span className="sp-num mission__value">+{m.credits}</span>
                    <span className="mission__xp">{m.xp} XP</span>
                    {m.done && !m.claimed && (
                      <Button
                        size="sm" variant="primary" disabled={ocupado !== null}
                        onClick={() => void resgatar(m)}
                      >
                        {ocupado === m.id ? '…' : 'Resgatar'}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="store__confirmActions">
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
        </div>

        {recado && (
          <div className={`store__toast${recado.ok ? ' is-ok' : ' is-bad'}`} role="status">{recado.texto}</div>
        )}
      </div>
    </div>
  );
}
