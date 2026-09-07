import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Agency, type AgencyInvite, type AgencyRole } from '../network/api.js';
import { useAccountStore } from '../state/useAccountStore.js';
import { short } from '../state/format.js';
import { Button, Notice } from './primitives/Controls.js';
import { IconShield } from './Icons.js';

/**
 * Agência (PRD §19).
 *
 * A tela tem dois estados, e os dois importam:
 *
 *   * **sem agência**: os convites recebidos primeiro, fundar depois. Quem foi
 *     chamado por alguém está a um clique de uma organização que já existe, e
 *     empurrar essa pessoa a fundar a própria seria trocar um grupo por uma
 *     lista de um nome só;
 *   * **com agência**: os membros com função e Creator Points, e as ações que a
 *     SUA função permite — nem uma a mais. Um botão que existe e responde 403 é
 *     pior do que botão nenhum.
 *
 * O que esta tela nunca faz é adicionar alguém: entrar é ato de duas vontades
 * (a agência convida, a pessoa aceita), e convidar acontece no perfil de quem
 * se quer convidar — é lá que se decide chamar uma pessoa, não numa lista.
 *
 * A agência só passa a aparecer ao lado do avatar na cidade no PRÓXIMO token
 * (até 15 min, §36), como a troca de roupa. A tela avisa isso em vez de deixar
 * a pessoa procurando o nome que não apareceu.
 */

const ROLE_LABEL: Record<AgencyRole, string> = {
  owner: 'Dono', manager: 'Gerente', member: 'Membro',
};

export interface AgencyPanelProps {
  onClose: () => void;
}

export function AgencyPanel({ onClose }: AgencyPanelProps) {
  const api = useAccountStore((s) => s.api);
  const userId = useAccountStore((s) => s.userId);
  const authenticated = useAccountStore((s) => Boolean(s.api?.authenticated));

  const [agency, setAgency] = useState<Agency | null>(null);
  const [role, setRole] = useState<AgencyRole | null>(null);
  const [invites, setInvites] = useState<AgencyInvite[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [nome, setNome] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [recado, setRecado] = useState<{ ok: boolean; texto: string } | null>(null);

  const recarregar = useCallback(async () => {
    if (!api?.authenticated) { setCarregando(false); return; }
    try {
      const meu = await api.myAgency();
      setAgency(meu.agency);
      setRole(meu.role);
      setInvites(meu.invites ?? []);
    } catch {
      setRecado({ ok: false, texto: 'Não foi possível carregar a agência agora.' });
    } finally {
      setCarregando(false);
    }
  }, [api]);

  useEffect(() => { void recarregar(); }, [recarregar]);

  const agir = async (acao: () => Promise<unknown>, sucesso: string) => {
    setOcupado(true);
    try {
      await acao();
      await recarregar();
      setRecado({ ok: true, texto: sucesso });
    } catch (err) {
      // A API escreve as recusas em português para o jogador ler; a tela
      // repassa em vez de traduzir um código.
      setRecado({ ok: false, texto: err instanceof ApiError ? err.message : 'Não deu certo agora.' });
    } finally {
      setOcupado(false);
      window.setTimeout(() => setRecado(null), 3200);
    }
  };

  const podeAdministrar = role === 'owner' || role === 'manager';

  return (
    <div className="store__confirm" role="dialog" aria-label="Agência">
      <div className="store__confirmBox agency">
        <header className="agency__head">
          <strong><IconShield size={15} /> Agência</strong>
          {agency && <span className="agency__level">nível {agency.level}</span>}
        </header>

        {!authenticated && <Notice tone="warn">Entre com a sua conta para participar de uma agência.</Notice>}
        {carregando && <p className="coinshop__hint">Carregando…</p>}

        {!carregando && !agency && (
          <>
            {invites.length > 0 && (
              <section className="agency__section">
                <h3 className="agency__title">Convites</h3>
                <ul className="coinshop__list">
                  {invites.map((c) => (
                    <li key={c.agencyId} className="coinshop__pack">
                      <div className="coinshop__packInfo">
                        <span className="coinshop__packName">{c.name}</span>
                        <span className="coinshop__packCoins">convidado por {c.invitedBy}</span>
                      </div>
                      <div className="agency__inviteActions">
                        <Button
                          size="sm" variant="ghost" disabled={ocupado}
                          onClick={() => void agir(() => api!.declineAgencyInvite(c.agencyId), 'Convite recusado.')}
                        >
                          Recusar
                        </Button>
                        <Button
                          size="sm" variant="primary" disabled={ocupado}
                          onClick={() => void agir(() => api!.acceptAgencyInvite(c.agencyId), `Você entrou na ${c.name}.`)}
                        >
                          Aceitar
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="agency__section">
              <h3 className="agency__title">Fundar a sua</h3>
              <p className="coinshop__hint">
                Uma agência reúne streamers sob um nome só — ele aparece ao lado do seu na cidade.
              </p>
              <div className="agency__form">
                <input
                  className="agency__input"
                  value={nome}
                  maxLength={24}
                  placeholder="Nome da agência"
                  aria-label="Nome da agência"
                  onChange={(e) => setNome(e.target.value)}
                />
                <Button
                  variant="primary"
                  disabled={!authenticated || ocupado || nome.trim().length < 3}
                  onClick={() => void agir(() => api!.createAgency(nome.trim()), 'Agência fundada.')}
                >
                  Fundar
                </Button>
              </div>
            </section>
          </>
        )}

        {!carregando && agency && (
          <>
            <section className="agency__section">
              <div className="agency__identity">
                <strong className="agency__name">{agency.name}</strong>
                <span className="coinshop__packCoins">
                  {agency.memberCount} {agency.memberCount === 1 ? 'membro' : 'membros'} ·{' '}
                  <span className="sp-num">{short(agency.fame)}</span> de fama
                </span>
              </div>
              <p className="coinshop__hint">
                Você é <strong>{ROLE_LABEL[role ?? 'member']}</strong>. Para convidar alguém, abra o
                perfil da pessoa. O nome da agência aparece ao lado do seu avatar na próxima entrada.
              </p>
            </section>

            <section className="agency__section">
              <h3 className="agency__title">Membros</h3>
              <ul className="coinshop__list">
                {(agency.members ?? []).map((m) => (
                  <li key={m.userId} className="coinshop__pack">
                    <div className="coinshop__packInfo">
                      <span className="coinshop__packName">
                        {m.displayName} <em className="agency__role">{ROLE_LABEL[m.role]}</em>
                      </span>
                      <span className="coinshop__packCoins">
                        <span className="sp-num">{short(m.creatorPoints)}</span> Creator Points
                      </span>
                    </div>
                    <div className="agency__inviteActions">
                      {role === 'owner' && m.role !== 'owner' && (
                        <Button
                          size="sm" variant="ghost" disabled={ocupado}
                          onClick={() => void agir(
                            () => api!.setAgencyRole(agency.agencyId, m.userId, m.role === 'manager' ? 'member' : 'manager'),
                            m.role === 'manager' ? 'Agora é membro.' : 'Agora é gerente.',
                          )}
                        >
                          {m.role === 'manager' ? 'Rebaixar' : 'Promover'}
                        </Button>
                      )}
                      {podeAdministrar && m.role !== 'owner' && m.userId !== userId && (
                        <Button
                          size="sm" variant="ghost" disabled={ocupado}
                          onClick={() => void agir(
                            () => api!.leaveAgency(agency.agencyId, m.userId), 'Desligado da agência.',
                          )}
                        >
                          Desligar
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="agency__section agency__danger">
              {role === 'owner' ? (
                <>
                  <p className="coinshop__hint">
                    O dono não sai da agência: passe a função para alguém pelo botão Promover e saia
                    depois, ou dissolva a agência.
                  </p>
                  <Button
                    variant="ghost" disabled={ocupado}
                    onClick={() => void agir(() => api!.disbandAgency(agency.agencyId), 'Agência dissolvida.')}
                  >
                    Dissolver agência
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost" disabled={ocupado}
                  onClick={() => void agir(
                    () => api!.leaveAgency(agency.agencyId, userId as string), 'Você saiu da agência.',
                  )}
                >
                  Sair da agência
                </Button>
              )}
            </section>
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
