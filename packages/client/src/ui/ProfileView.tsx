import { useEffect, useState } from 'react';
import { GIFTER_TIERS, gifterTierFor } from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import { useSocialStore } from '../state/useSocialStore.js';
import type { OnboardingStep, PublicProfile, ReportType } from '../network/api.js';
import { presenceLabel, short } from '../state/format.js';
import { usePoster } from './usePoster.js';
import { OnboardingCard } from './OnboardingCard.js';
import { Button, GifterBadge, LiveDot, Money, Stat } from './primitives/Controls.js';
import { IconClose, IconCoin, IconCredits, IconCrown, IconEye, IconShield, IconSparkle, IconUser } from './Icons.js';
import './friends.css';

/**
 * Perfil (PRD §15).
 *
 * A ideia que separa este perfil de uma tela de rede social: ele termina numa
 * PORTA. "Visitar apartamento" não abre uma galeria de fotos — sai da interface
 * 2D e entra na casa da pessoa, no mundo 3D, pela mesma conexão do jogo. O
 * mesmo vale para "Assistir": o perfil de quem está no ar leva para dentro da
 * live.
 *
 * Tudo que aparece aqui é resposta do servidor. Fama, seguidores e nível de
 * gifter não são somados no cliente em lugar nenhum.
 */

export interface ProfileViewProps {
  /** Perfil a mostrar; nulo é o do próprio jogador. */
  userId: string | null;
  onVisitApartment: (apartmentId: string) => void;
  onWatchLive: (roomId: string) => void;
  onEditLook: () => void;
  /** Sair da conta de demonstração e voltar para a escolha de personagem. */
  onLeave?: () => void;
  /** Abrir a lista de amigos (só faz sentido no próprio perfil). */
  onOpenFriends?: () => void;
  /** Ir até onde este amigo está agora. A casca pede o endereço e viaja. */
  onMeet?: (userId: string) => void;
  /** Levar o jogador até onde o passo da volta guiada acontece. */
  onTourAction?: (step: OnboardingStep) => void;
}

export function ProfileView({
  userId, onVisitApartment, onWatchLive, onEditLook, onLeave,
  onOpenFriends, onMeet, onTourAction,
}: ProfileViewProps) {
  const api = useAccountStore((s) => s.api);
  const mine = useAccountStore((s) => s.profile);
  const wallet = useAccountStore((s) => s.wallet);
  const followingSet = useAccountStore((s) => s.following);
  const setFollow = useAccountStore((s) => s.setFollow);

  const social = useSocialStore();
  const [profile, setProfile] = useState<PublicProfile | null>(userId ? null : mine);
  const [error, setError] = useState<string | null>(null);
  /** Resposta curta da última ação social ("Convite enviado", "Bloqueado"). */
  const [recado, setRecado] = useState<string | null>(null);
  const [denunciando, setDenunciando] = useState(false);
  const [enviandoDenuncia, setEnviandoDenuncia] = useState(false);

  useEffect(() => {
    if (!userId) { setProfile(mine); return; }
    let alive = true;
    setProfile(null);
    setError(null);
    setRecado(null);
    api?.profile(userId)
      .then((p) => { if (alive) setProfile(p); })
      .catch(() => { if (alive) setError('Não foi possível carregar este perfil.'); });
    return () => { alive = false; };
  }, [userId, api, mine]);

  // A volta guiada e os convites pendentes só interessam no PRÓPRIO perfil, e
  // é aqui que se chega para ver "o meu". Recarregados a cada abertura porque
  // os dois mudam por fora desta tela — um passo se cumpre andando pela cidade.
  const loadOnboarding = useSocialStore((s) => s.loadOnboarding);
  const loadFriends = useSocialStore((s) => s.load);
  useEffect(() => {
    if (userId) return;
    void loadOnboarding();
    void loadFriends();
  }, [userId, loadOnboarding, loadFriends]);

  /**
   * Toda mutação social é: chama, relê o perfil.
   *
   * Reler é o ponto — a amizade tem quatro estados que dependem de quem pediu, e
   * adivinhar o próximo no cliente é criar um segundo lugar onde "somos amigos?"
   * é decidido. O servidor já respondeu; basta perguntar de novo.
   */
  const agir = async (acao: () => Promise<unknown>, aviso?: string) => {
    await acao();
    if (aviso) setRecado(aviso);
    if (profile) {
      const fresco = await api?.profile(profile.userId).catch(() => null);
      if (fresco) setProfile(fresco);
    }
  };

  const poster = usePoster(profile?.avatar, { shot: 'full', at: 1.9, width: 360, height: 500 });

  if (error) return <section className="screen"><p className="screen__hint">{error}</p></section>;
  if (!profile) return <section className="screen"><p className="screen__hint">Carregando perfil…</p></section>;

  const isFollowing = profile.isFollowing || followingSet.has(profile.userId);
  const tier = gifterTierFor(profile.gifterXp);
  /**
   * A porta do próprio jogador nunca está fechada — mesmo quando ela ainda não
   * existe. Conta recém-criada não tem linha de apartamento: a casa nasce na
   * primeira visita (`getOrCreateHomeOf`), e `me` é o pedido que a API traduz.
   * Enquanto isto olhava só para o `apartmentId`, quem acabava de se cadastrar
   * via o próprio botão de casa desligado — o que lê como "você não tem casa"
   * num jogo cujo PRD diz que todo mundo tem.
   */
  const canVisit = profile.isSelf
    || Boolean(profile.apartmentId && profile.apartmentVisibility === 'open');
  const minhaPorta = profile.apartmentId ?? 'me';

  return (
    <section className="screen profile">
      {profile.isSelf && social.onboarding && onTourAction && (
        <OnboardingCard tour={social.onboarding} onAction={onTourAction} />
      )}

      <div className="profile__hero">
        <div className="profile__poster">
          {poster
            ? <img src={poster} alt={`Avatar de ${profile.displayName}`} />
            : <div className="profile__posterSkeleton" />}
          {profile.isLive && <span className="profile__liveTag"><LiveDot /></span>}
        </div>

        <div className="profile__id">
          <h1 className="profile__name">{profile.displayName}</h1>
          <p className="profile__handle">@{profile.username}</p>
          {profile.bio && <p className="profile__bio">{profile.bio}</p>}

          <div className="profile__counts">
            <Stat label="Fame" value={short(profile.fame)} />
            <Stat label="Seguidores" value={short(profile.followers)} />
            <Stat label="Seguindo" value={short(profile.following)} />
          </div>

          <div className="profile__badges">
            <GifterBadge xp={profile.gifterXp} />
            <span className="chip"><IconSparkle size={13} /> Nível {profile.level}</span>
            {profile.agency && <span className="chip"><IconShield size={13} /> {profile.agency}</span>}
            {profile.gifterLevel >= 4 && (
              <span className="chip chip--gold"><IconCrown size={13} /> {tier.name}</span>
            )}
          </div>

          <div className="profile__actions">
            {!profile.isSelf && (
              <Button
                variant={isFollowing ? 'secondary' : 'primary'}
                onClick={() => void setFollow(profile.userId, !isFollowing)}
              >
                {isFollowing ? 'Seguindo' : 'Seguir'}
              </Button>
            )}

            {/* Seguir e ser amigo são botões diferentes porque são coisas
                diferentes: seguir é assinar o conteúdo de alguém, e amizade é
                o que abre o apartamento fechado e o "Encontrar". */}
            {!profile.isSelf && !profile.isBlocked && (
              <BotaoAmizade
                profile={profile}
                busy={social.busy === profile.userId}
                onRequest={() => void agir(async () => {
                  setRecado((await social.request(profile.userId)).message);
                })}
                onAccept={() => void agir(() => social.accept(profile.userId), 'Vocês agora são amigos!')}
                onDecline={() => void agir(() => social.decline(profile.userId))}
                onRemove={() => void agir(() => social.remove(profile.userId))}
              />
            )}

            {/* Encontrar só aparece para amigo que está no mundo AGORA: o
                endereço vem da presença, e presença de quem saiu é `null`. */}
            {!profile.isSelf && profile.friendship === 'friends'
              && onMeet && presenceLabel(profile.presence) !== 'Offline' && (
              <Button variant="secondary" onClick={() => onMeet(profile.userId)}>Encontrar</Button>
            )}

            {profile.isLive && profile.liveRoomId && (
              <Button variant="live" icon={<IconEye size={16} />} onClick={() => onWatchLive(profile.liveRoomId as string)}>
                Assistir
              </Button>
            )}
            {profile.isSelf && <Button variant="secondary" onClick={onEditLook}>Editar look</Button>}
            {profile.isSelf && onOpenFriends && (
              <Button
                variant="secondary"
                icon={<IconUser size={16} />}
                onClick={onOpenFriends}
              >
                Amigos{social.incoming.length > 0 ? ` (${social.incoming.length})` : ''}
              </Button>
            )}
            {profile.isSelf && onLeave && (
              <Button variant="ghost" onClick={onLeave}>Trocar de personagem</Button>
            )}
          </div>

          {/* Bloquear e denunciar ficam separados das ações positivas e em
              tom neutro: são saídas de emergência, não algo a se oferecer no
              mesmo peso de "Seguir". */}
          {!profile.isSelf && (
            <div className="profile__safety">
              <button
                type="button"
                className="profile__safetyLink"
                onClick={() => void agir(
                  async () => {
                    const r = await social.setBlocked(profile.userId, !profile.isBlocked);
                    setRecado(r.message);
                  },
                )}
              >
                {profile.isBlocked ? 'Desbloquear' : 'Bloquear'}
              </button>
              <button type="button" className="profile__safetyLink" onClick={() => setDenunciando(true)}>
                Denunciar
              </button>
            </div>
          )}

          {recado && <p className="screen__hint" role="status">{recado}</p>}
          {profile.isBlocked && (
            <p className="screen__hint">
              Você bloqueou esta pessoa: vocês não podem ser amigos nem se
              encontrar enquanto o bloqueio existir.
            </p>
          )}

          {profile.isSelf && (
            <div className="profile__wallet">
              <Money currency="credits" amount={wallet.credits} icon={<IconCredits size={15} />} />
              <Money currency="coins" amount={wallet.coins} icon={<IconCoin size={15} />} />
            </div>
          )}

          <div className="profile__grid">
            <Stat label="Creator Points" value={short(profile.creatorPoints)} hint="Pontos ganhos transmitindo" />
            <Stat label="Gifter XP" value={short(profile.gifterXp)} hint={`Faltam ${short(nextTierGap(profile.gifterXp))} para o próximo nível`} />
            <Stat label="Presença" value={presenceLabel(profile.presence)} />
            <Stat
              label="Apartamento"
              value={profile.apartmentId ? visibilityLabel(profile.apartmentVisibility) : '—'}
            hint={profile.isSelf ? 'Só você decide quem entra' : undefined}
          />
          </div>
        </div>
      </div>

      <div className="profile__door">
        <Button
          variant="primary"
          size="lg"
          block
          disabled={!canVisit}
          onClick={() => canVisit && onVisitApartment(profile.isSelf ? minhaPorta : profile.apartmentId as string)}
        >
          {profile.isSelf ? 'Ir para o meu apartamento' : 'Visitar apartamento'}
        </Button>
        {!canVisit && !profile.isSelf && (
          <p className="screen__hint">
            {profile.apartmentId
              ? (profile.apartmentVisibility === 'friends'
                // A porta `friends` é o motivo mais concreto para mandar um
                // convite, e dizer "fechada" esconderia que ela abre.
                ? 'Este apartamento abre só para amigos.'
                : 'A porta está fechada para visitas.')
              : 'Esta pessoa ainda não tem um apartamento.'}
          </p>
        )}
      </div>

      {denunciando && (
        <SheetDenuncia
          nome={profile.displayName}
          busy={enviandoDenuncia}
          onClose={() => setDenunciando(false)}
          onSend={(type, reason) => {
            setEnviandoDenuncia(true);
            void api?.report(profile.userId, type, reason)
              .then((r) => setRecado(r.duplicate
                // Denúncia repetida não vira linha nova na fila (ver a API), e
                // dizer "enviada!" de novo faria o jogador achar que a
                // primeira se perdeu.
                ? 'Você já tinha denunciado isso; a denúncia continua em análise.'
                : 'Denúncia registrada. Obrigado por avisar.'))
              .catch(() => setRecado('Não foi possível enviar a denúncia agora.'))
              .finally(() => { setEnviandoDenuncia(false); setDenunciando(false); });
          }}
        />
      )}
    </section>
  );
}

function nextTierGap(xp: number): number {
  const next = GIFTER_TIERS.find((t) => t.xp > xp);
  return next ? next.xp - xp : 0;
}

/**
 * O botão da amizade tem quatro caras porque a relação tem quatro estados, e
 * cada um pede uma frase diferente: convidar, esperar, responder, desfazer.
 * Um botão só, alternando "Adicionar/Remover", esconderia o convite que chegou
 * — que é justamente o estado em que a outra pessoa está esperando por você.
 */
function BotaoAmizade(
  { profile, busy, onRequest, onAccept, onDecline, onRemove }: {
    profile: PublicProfile;
    busy: boolean;
    onRequest: () => void;
    onAccept: () => void;
    onDecline: () => void;
    onRemove: () => void;
  },
) {
  if (profile.friendship === 'friends') {
    return <Button variant="secondary" disabled={busy} onClick={onRemove}>Amigos ✓</Button>;
  }
  if (profile.friendship === 'incoming') {
    return (
      <>
        <Button variant="primary" disabled={busy} onClick={onAccept}>Aceitar amizade</Button>
        <Button variant="ghost" disabled={busy} onClick={onDecline}>Recusar</Button>
      </>
    );
  }
  if (profile.friendship === 'outgoing') {
    return <Button variant="ghost" disabled={busy} onClick={onRemove}>Convite enviado</Button>;
  }
  return <Button variant="secondary" disabled={busy} onClick={onRequest}>Adicionar amigo</Button>;
}

const MOTIVOS: Array<{ id: ReportType; label: string }> = [
  { id: 'chat', label: 'Mensagens no chat' },
  { id: 'profile', label: 'Perfil (nome ou bio)' },
  { id: 'live', label: 'Conteúdo de uma live' },
  { id: 'avatar', label: 'Aparência do avatar' },
  { id: 'other', label: 'Outro' },
];

/**
 * Denúncia (PRD §27).
 *
 * O texto é obrigatório e a categoria também: uma fila de denúncias sem motivo
 * escrito é uma lista de nomes, e quem for ler não tem como decidir nada. Nada
 * acontece com a conta denunciada por causa deste formulário — isso é decisão
 * de moderação humana, e automatizá-la seria transformar o botão numa arma.
 */
function SheetDenuncia(
  { nome, busy, onSend, onClose }: {
    nome: string;
    busy: boolean;
    onSend: (type: ReportType, reason: string) => void;
    onClose: () => void;
  },
) {
  const [type, setType] = useState<ReportType>('chat');
  const [reason, setReason] = useState('');

  return (
    <div className="sheet" role="dialog" aria-label={`Denunciar ${nome}`}>
      <form
        className="sheet__box"
        onSubmit={(e) => { e.preventDefault(); onSend(type, reason.trim()); }}
      >
        <header className="sheet__head">
          <strong>Denunciar {nome}</strong>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Fechar">
            <IconClose size={16} />
          </button>
        </header>

        <div className="sheet__chips">
          {MOTIVOS.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`sheet__chip${type === m.id ? ' is-on' : ''}`}
              onClick={() => setType(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <label className="sheet__label" htmlFor="report-reason">O que aconteceu?</label>
        <textarea
          id="report-reason"
          className="sheet__input sheet__input--area"
          value={reason}
          maxLength={1000}
          rows={4}
          placeholder="Conte o que você viu, com o máximo de detalhe que lembrar."
          onChange={(e) => setReason(e.target.value)}
        />

        <p className="sheet__note">
          Uma pessoa da moderação vai ler. A conta denunciada não é avisada e
          nada acontece com ela automaticamente.
        </p>
        <Button variant="primary" size="lg" block type="submit" disabled={busy || reason.trim().length < 3}>
          Enviar denúncia
        </Button>
      </form>
    </div>
  );
}

function visibilityLabel(v: PublicProfile['apartmentVisibility']): string {
  if (v === 'open') return 'Aberto';
  return v === 'friends' ? 'Só amigos' : 'Fechado';
}
