/**
 * Fixture data for the UI lab.
 *
 * Everything here is deterministic: the screens are reviewed by screenshot, so
 * a random seed would make two captures of the same build disagree. Delete
 * this file once `network/` feeds the stores for real.
 */
import { DEFAULT_AVATAR, GIFT_CATALOG, type AvatarConfig } from '@streampolis/shared';
import type {
  ChatMessage, LiveCard, LiveSummary, Mission, PersonRef, PKState,
  ProfileVM, RankingBoard, RankingRange, RankingRow,
} from './types.js';

const av = (o: Partial<AvatarConfig>): AvatarConfig => ({ ...DEFAULT_AVATAR, ...o });

export const PEOPLE: Record<string, PersonRef> = {
  me: {
    id: 'u_me', name: 'Nina Vasq', handle: '@ninav', gifterXp: 14_820,
    agency: 'Neon Bloom', verified: false,
    avatar: av({ skinTone: 3, hair: 'hair_long_01', hairColor: 6, top: 'top_holo_01', bottom: 'bottom_skirt_01', shoes: 'shoes_glow_01' }),
  },
  kira: {
    id: 'u_kira', name: 'Kira Mochi', handle: '@kiramochi', gifterXp: 512_000,
    agency: 'Neon Bloom', verified: true,
    avatar: av({ skinTone: 1, hair: 'hair_bob_01', hairColor: 8, top: 'top_holo_01', bottom: 'bottom_track_01', shoes: 'shoes_glow_01', accessory: 'acc_halo_01' }),
  },
  dante: {
    id: 'u_dante', name: 'Dante Rios', handle: '@dnt', gifterXp: 61_400,
    agency: 'Vértice', verified: true,
    avatar: av({ skinTone: 5, bodyPreset: 1, hair: 'hair_buzz_01', hairColor: 0, top: 'top_jacket_01', bottom: 'bottom_cargo_01', shoes: 'shoes_boot_01' }),
  },
  lu: {
    id: 'u_lu', name: 'Lu Andrade', handle: '@luandrade', gifterXp: 3_120,
    agency: null, verified: false,
    avatar: av({ skinTone: 6, bodyPreset: 2, hair: 'hair_braids_01', hairColor: 1, top: 'top_hoodie_01', bottom: 'bottom_jeans_01' }),
  },
  yuki: {
    id: 'u_yuki', name: 'Yuki Tanaka', handle: '@yukiii', gifterXp: 240_900,
    agency: 'Aurora Cast', verified: true,
    avatar: av({ skinTone: 2, bodyPreset: 3, hair: 'hair_ponytail_01', hairColor: 4, top: 'top_blazer_01', bottom: 'bottom_track_01', accessory: 'acc_glasses_01' }),
  },
  bento: {
    id: 'u_bento', name: 'Bento Lima', handle: '@bentin', gifterXp: 640,
    agency: null, verified: false,
    avatar: av({ skinTone: 4, hair: 'hair_afro_01', hairColor: 2, top: 'top_tee_01', bottom: 'bottom_cargo_01' }),
  },
  sol: {
    id: 'u_sol', name: 'Sol Marinho', handle: '@solzin', gifterXp: 98_400,
    agency: 'Vértice', verified: false,
    avatar: av({ skinTone: 0, bodyPreset: 2, hair: 'hair_mohawk_01', hairColor: 9, top: 'top_jacket_01', shoes: 'shoes_glow_01' }),
  },
  rafa: {
    id: 'u_rafa', name: 'Rafa Prado', handle: '@rafapd', gifterXp: 27_300,
    agency: 'Aurora Cast', verified: false,
    avatar: av({ skinTone: 7, bodyPreset: 1, hair: 'hair_buzz_01', hairColor: 0, top: 'top_hoodie_01', shoes: 'shoes_boot_01' }),
  },
};

export const FEED: LiveCard[] = [
  { liveId: 'l1', host: PEOPLE.kira, title: 'PK final da temporada — vem com tudo', category: 'PK', realViewers: 2841, isPK: true, agency: 'Neon Bloom', badge: 'event', startedAt: Date.now() - 41 * 60_000, hue: 318 },
  { liveId: 'l2', host: PEOPLE.dante, title: 'Montando o setup novo do apê', category: 'Bate-papo', realViewers: 734, isPK: false, agency: 'Vértice', badge: 'partner', startedAt: Date.now() - 12 * 60_000, hue: 202 },
  { liveId: 'l3', host: PEOPLE.lu, title: 'Sessão acústica na praça central', category: 'Música', realViewers: 189, isPK: false, agency: null, badge: 'rising', startedAt: Date.now() - 6 * 60_000, hue: 44 },
  { liveId: 'l4', host: PEOPLE.yuki, title: 'Treino de dança pro evento de sexta', category: 'Dança', realViewers: 1206, isPK: false, agency: 'Aurora Cast', badge: 'partner', startedAt: Date.now() - 88 * 60_000, hue: 268 },
  { liveId: 'l5', host: PEOPLE.bento, title: 'primeira live, sejam gentis kk', category: 'Bate-papo', realViewers: 23, isPK: false, agency: null, badge: 'none', startedAt: Date.now() - 3 * 60_000, hue: 152 },
  { liveId: 'l6', host: PEOPLE.sol, title: 'Maratona de missões até o nível 30', category: 'Jogos', realViewers: 412, isPK: false, agency: 'Vértice', badge: 'none', startedAt: Date.now() - 133 * 60_000, hue: 8 },
  { liveId: 'l7', host: PEOPLE.rafa, title: 'Testando os cabelos novos da loja', category: 'Beleza', realViewers: 96, isPK: false, agency: 'Aurora Cast', badge: 'rising', startedAt: Date.now() - 27 * 60_000, hue: 176 },
];

const t0 = Date.now() - 120_000;
export const CHAT: ChatMessage[] = [
  { id: 'c1', kind: 'system', text: 'Bem-vindo à live de Kira Mochi. Respeite as regras da comunidade.', ts: t0 },
  { id: 'c2', kind: 'join', sender: PEOPLE.bento, text: 'entrou na live', ts: t0 + 4_000 },
  { id: 'c3', kind: 'user', sender: PEOPLE.lu, text: 'boa noite genteee, cheguei correndo', ts: t0 + 9_000 },
  { id: 'c4', kind: 'user', sender: PEOPLE.dante, text: 'esse cenário novo ficou absurdo', ts: t0 + 15_000 },
  { id: 'c5', kind: 'gift', sender: PEOPLE.yuki, text: 'enviou Coração', giftId: 'g_heart', quantity: 10, ts: t0 + 21_000 },
  { id: 'c6', kind: 'user', sender: PEOPLE.bento, text: 'alguém sabe quanto custa o halo?', ts: t0 + 26_000 },
  { id: 'c7', kind: 'user', sender: PEOPLE.sol, text: '1200 coins, comprei ontem e não me arrependo', ts: t0 + 31_000 },
  { id: 'c8', kind: 'follow', sender: PEOPLE.rafa, text: 'começou a seguir', ts: t0 + 37_000 },
  { id: 'c9', kind: 'user', sender: PEOPLE.lu, text: 'mensagem removida pela moderação', ts: t0 + 44_000, filtered: true },
  { id: 'c10', kind: 'gift', sender: PEOPLE.dante, text: 'enviou Diamante', giftId: 'g_diamond', quantity: 1, ts: t0 + 52_000 },
  { id: 'c11', kind: 'user', sender: PEOPLE.yuki, text: 'o PK começa em dois minutos, avisa a galera', ts: t0 + 61_000 },
  { id: 'c12', kind: 'user', sender: PEOPLE.me, text: 'já tô com os presentes separados', ts: t0 + 70_000 },
  { id: 'c13', kind: 'gift', sender: PEOPLE.sol, text: 'enviou Rocket', giftId: 'g_rocket', quantity: 1, ts: t0 + 78_000 },
  { id: 'c14', kind: 'system', text: 'Rocket de Sol Marinho — o placar do PK foi atualizado.', ts: t0 + 78_500 },
  { id: 'c15', kind: 'user', sender: PEOPLE.bento, text: 'CARAMBA', ts: t0 + 81_000 },
];

export const PK: PKState = {
  phase: 'ACTIVE',
  msRemaining: 74_000,
  winner: null,
  a: { streamer: PEOPLE.kira, score: 18_420, topGifter: { name: 'Sol Marinho', coins: 9_999 } },
  b: { streamer: PEOPLE.yuki, score: 16_105, topGifter: { name: 'Dante Rios', coins: 4_990 } },
};

export const SUMMARY: LiveSummary = {
  title: 'Montando o setup novo do apê',
  category: 'Bate-papo',
  durationMs: 82 * 60_000 + 14_000,
  uniqueViewers: 1_284,
  peakViewers: 317,
  newFollowers: 96,
  messages: 2_140,
  likes: 18_902,
  creatorPoints: 24_680,
  fameGained: 1_310,
  gifts: [
    { giftId: 'g_rose', quantity: 412, coins: 412 },
    { giftId: 'g_heart', quantity: 88, coins: 1_760 },
    { giftId: 'g_star', quantity: 31, coins: 3_069 },
    { giftId: 'g_diamond', quantity: 7, coins: 3_493 },
    { giftId: 'g_rocket', quantity: 1, coins: 9_999 },
  ],
  records: ['Novo pico de espectadores', 'Maior número de seguidores em uma live'],
};

export const PROFILE: ProfileVM = {
  person: PEOPLE.kira,
  bio: 'Cantora e host da Neon Bloom. Live todo dia às 21h, PK nas sextas. Sem drama, só música.',
  fame: 184_920,
  followers: 41_803,
  following: 312,
  streamerRank: 4,
  isSelf: false,
  isFollowing: false,
  apartmentPublic: true,
  badges: [
    { id: 'b1', label: 'Top 5 da temporada', color: '#ffc247', hint: 'Ficou entre os 5 primeiros do ranking de streamers.' },
    { id: 'b2', label: 'Campeã de PK', color: '#ff2d6f', hint: '30 vitórias em PK na temporada atual.' },
    { id: 'b3', label: 'Fundadora', color: '#5ee7ff', hint: 'Entrou durante o acesso antecipado.' },
  ],
  stats: [
    { label: 'Lives', value: '318' },
    { label: 'Horas ao vivo', value: '742' },
    { label: 'PKs vencidos', value: '187' },
    { label: 'Creator Points', value: '4,2 M' },
  ],
  collection: ['acc_halo_01', 'top_holo_01', 'shoes_glow_01', 'hair_mohawk_01', 'gear_backdrop_01', 'fur_neon_01'],
};

export const MISSIONS: Mission[] = [
  { id: 'm1', label: 'Complete seu avatar', done: true, reward: '250 Credits' },
  { id: 'm2', label: 'Visite a praça central', done: true, reward: '100 Credits' },
  { id: 'm3', label: 'Assista a uma live', done: true, reward: '150 Credits' },
  { id: 'm4', label: 'Siga um streamer', done: false, reward: '100 Credits' },
  { id: 'm5', label: 'Personalize seu apartamento', done: false, reward: 'Tapete + 200 XP' },
  { id: 'm6', label: 'Faça sua primeira live', done: false, reward: '500 Credits' },
];

const RANK_POOL = [PEOPLE.kira, PEOPLE.yuki, PEOPLE.dante, PEOPLE.sol, PEOPLE.rafa, PEOPLE.me, PEOPLE.lu, PEOPLE.bento];
const AGENCIES = ['Neon Bloom', 'Aurora Cast', 'Vértice', 'Casa Bruta', 'Estúdio Sal'];

const BOARD_META: Record<RankingBoard, { unit: string; base: number }> = {
  streamers: { unit: 'Fame', base: 184_920 },
  gifters: { unit: 'Coins enviados', base: 512_000 },
  pk: { unit: 'PK Points', base: 96_400 },
  agencies: { unit: 'Fame agregada', base: 1_240_000 },
};

const RANGE_SCALE: Record<RankingRange, number> = { today: 0.07, week: 0.34, season: 1 };

export function rankingRows(board: RankingBoard, range: RankingRange): RankingRow[] {
  const meta = BOARD_META[board];
  const scale = RANGE_SCALE[range];
  const deltas = [0, 2, -1, 0, 3, -2, 1, 0];
  if (board === 'agencies') {
    return AGENCIES.map((name, i) => ({
      id: `ag_${i}`,
      rank: i + 1,
      delta: deltas[i] ?? 0,
      name,
      subtitle: `${18 - i * 3} membros · ${meta.unit}`,
      value: Math.round(meta.base * scale * (1 - i * 0.17)),
      isSelf: name === 'Neon Bloom',
    }));
  }
  return RANK_POOL.map((p, i) => ({
    id: `${board}_${p.id}`,
    rank: i + 1,
    delta: deltas[i] ?? 0,
    name: p.name,
    subtitle: p.agency ? `${p.agency} · ${meta.unit}` : `Independente · ${meta.unit}`,
    value: Math.round(meta.base * scale * (1 - i * 0.13)),
    avatar: p.avatar,
    gifterXp: p.gifterXp,
    isSelf: p.id === PEOPLE.me.id,
  }));
}

export const OWNED_ITEMS = new Set([
  'hair_bob_01', 'hair_long_01', 'top_tee_01', 'top_holo_01', 'bottom_jeans_01',
  'bottom_skirt_01', 'shoes_sneaker_01', 'shoes_glow_01', 'fur_sofa_01', 'fur_plant_01',
  'floor_wood_01', 'wall_paint_01',
]);

export const GIFT_IDS = GIFT_CATALOG.map((g) => g.id);
