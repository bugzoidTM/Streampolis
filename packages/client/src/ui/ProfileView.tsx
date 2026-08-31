import { useEffect, useState } from 'react';
import { GIFTER_TIERS, gifterTierFor } from '@streampolis/shared';
import { useAccountStore } from '../state/useAccountStore.js';
import type { PublicProfile } from '../network/api.js';
import { short } from '../state/format.js';
import { usePoster } from './usePoster.js';
import { Button, GifterBadge, LiveDot, Money, Stat } from './primitives/Controls.js';
import { IconCoin, IconCredits, IconCrown, IconEye, IconHeartFilled, IconShield, IconSparkle } from './Icons.js';

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
}

export function ProfileView({ userId, onVisitApartment, onWatchLive, onEditLook, onLeave }: ProfileViewProps) {
  const api = useAccountStore((s) => s.api);
  const mine = useAccountStore((s) => s.profile);
  const wallet = useAccountStore((s) => s.wallet);
  const followingSet = useAccountStore((s) => s.following);
  const setFollow = useAccountStore((s) => s.setFollow);

  const [profile, setProfile] = useState<PublicProfile | null>(userId ? null : mine);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setProfile(mine); return; }
    let alive = true;
    setProfile(null);
    setError(null);
    api?.profile(userId)
      .then((p) => { if (alive) setProfile(p); })
      .catch(() => { if (alive) setError('Não foi possível carregar este perfil.'); });
    return () => { alive = false; };
  }, [userId, api, mine]);

  const poster = usePoster(profile?.avatar, { shot: 'full', at: 1.9, width: 360, height: 500 });

  if (error) return <section className="screen"><p className="screen__hint">{error}</p></section>;
  if (!profile) return <section className="screen"><p className="screen__hint">Carregando perfil…</p></section>;

  const isFollowing = profile.isFollowing || followingSet.has(profile.userId);
  const tier = gifterTierFor(profile.gifterXp);
  const canVisit = profile.apartmentId && (profile.isSelf || profile.apartmentVisibility === 'open');

  return (
    <section className="screen profile">
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
            {profile.isLive && profile.liveRoomId && (
              <Button variant="live" icon={<IconEye size={16} />} onClick={() => onWatchLive(profile.liveRoomId as string)}>
                Assistir
              </Button>
            )}
            {profile.isSelf && <Button variant="secondary" onClick={onEditLook}>Editar look</Button>}
            {profile.isSelf && onLeave && (
              <Button variant="ghost" onClick={onLeave}>Trocar de personagem</Button>
            )}
          </div>

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
          onClick={() => canVisit && onVisitApartment(profile.apartmentId as string)}
        >
          {profile.isSelf ? 'Ir para o meu apartamento' : 'Visitar apartamento'}
        </Button>
        {!canVisit && !profile.isSelf && (
          <p className="screen__hint">
            {profile.apartmentId ? 'A porta está fechada para visitas.' : 'Esta pessoa ainda não tem um apartamento.'}
          </p>
        )}
      </div>
    </section>
  );
}

function nextTierGap(xp: number): number {
  const next = GIFTER_TIERS.find((t) => t.xp > xp);
  return next ? next.xp - xp : 0;
}

function presenceLabel(presence: string): string {
  switch (presence) {
    case 'streaming': return 'Transmitindo';
    case 'watching_live': return 'Assistindo';
    case 'in_pk': return 'Em PK';
    case 'in_world': return 'Na cidade';
    case 'online': return 'Online';
    default: return 'Offline';
  }
}

function visibilityLabel(v: PublicProfile['apartmentVisibility']): string {
  if (v === 'open') return 'Aberto';
  return v === 'friends' ? 'Só amigos' : 'Fechado';
}
