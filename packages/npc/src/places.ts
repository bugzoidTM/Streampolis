import { PLAZA, PORTALS, SCENE_COLLIDERS, penetrates } from './shared.js';
import type { Point } from './walker.js';
import { fold } from './text.js';

/**
 * O que existe na praça, com nome e lugar — a percepção do personagem.
 *
 * Sem isto ele inventa: "sunset live no telão", "café do quiosque", "luzes de
 * led na avenida". Um modelo de linguagem preenche o que não vê com o que
 * soa bem, e o único remédio é dizer o que HÁ, com distância e direção, e o
 * que NÃO há. Cada lugar aqui é também um destino que as pernas alcançam
 * (`standing` fica fora dos colisores), então "me leva até o telão" vira uma
 * ação e não uma promessa.
 */
export interface Place {
  /** Como o personagem chama o lugar. */
  name: string;
  /** Apelidos que uma pessoa digita no chat (sem acento, minúsculo). */
  aliases: string[];
  /** Onde o lugar É (para "está a N m"). */
  at: Point;
  /** Onde se fica em pé para estar "no" lugar. */
  standing: Point;
  /** O que ele sabe dizer sobre o lugar — só fatos. */
  about: string;
}

const colliders = SCENE_COLLIDERS.central_plaza;

/** Recuo radial em direção ao centro, para ficar em pé na frente de algo no anel. */
function inward(p: Point, back: number): Point {
  const r = Math.hypot(p.x, p.z);
  if (r < 1e-6) return { x: 0, z: back };
  const k = (r - back) / r;
  return { x: p.x * k, z: p.z * k };
}

function free(p: Point, fallback: Point): Point {
  return penetrates(p, colliders) ? fallback : p;
}

function plazaPlaces(): Place[] {
  const out: Place[] = [];
  const screen = PLAZA.screen;
  out.push({
    name: 'o telão',
    aliases: ['telao', 'tela', 'telona', 'painel', 'video', 'videos'],
    at: { x: screen.x, z: screen.z },
    standing: free({ x: screen.x, z: screen.z + 8 }, { x: 2.2, z: -23.4 }),
    about: 'O telão mostra vídeos curtos da cidade, em silêncio, o dia inteiro. Na frente dele há uma clareira sem árvores.',
  });
  out.push({
    name: 'o monumento',
    aliases: ['monumento', 'fonte', 'estatua', 'centro', 'meio da praca'],
    at: { x: 0, z: 0 },
    standing: free({ x: 0, z: 9 }, { x: 9, z: 0 }),
    about: 'O monumento fica no centro exato da praça, num degrau de pedra. Tudo na praça é um anel em volta dele.',
  });
  PLAZA.kiosks.forEach((k, i) => {
    out.push({
      name: i === 0 ? 'o quiosque leste' : i === 1 ? 'o quiosque oeste' : 'o quiosque norte',
      aliases: i === 0 ? ['quiosque', 'quiosque leste', 'banca'] : i === 1 ? ['quiosque oeste'] : ['quiosque norte'],
      at: { x: k.x, z: k.z },
      standing: free(inward({ x: k.x, z: k.z }, 3.2), { x: 0, z: 9 }),
      about: 'Um quiosque fechado, de enfeite: não vende nada, não tem café nem comida. As pessoas param ao lado dele para conversar.',
    });
  });
  for (const portal of PORTALS.central_plaza ?? []) {
    const p = { x: portal.x, z: portal.z };
    const aliases: Record<string, string[]> = {
      plaza_store: ['loja', 'stream store', 'store', 'roupa', 'roupas', 'visual', 'itens'],
      plaza_tower: ['torre residencial', 'torre', 'predio', 'apartamento', 'apartamentos', 'casa', 'quarto', 'moradia'],
      plaza_agency: ['torre das agencias', 'agencia', 'agencias'],
      plaza_noir: ['distrito sombra', 'distrito', 'sombra', 'bairro', 'clube', 'clube sombra', 'balada', 'discoteca', 'bico', 'bicos', 'avenida'],
    };
    const about: Record<string, string> = {
      plaza_store: 'A porta da Stream Store, a loja de roupas, visuais e itens. Entra-se pela porta; eu não entro.',
      plaza_tower: 'A porta da Torre Residencial, onde ficam os apartamentos das pessoas. Eu não entro em prédio.',
      plaza_agency: 'A porta da Torre das Agências, onde as agências de streamers ficam. Eu não entro.',
      plaza_noir: 'A boca de rua para o Distrito Sombra: um bairro noturno com uma avenida e uma travessa, bicos pagos em Credits e o Clube Sombra. Levo até a porta; não saio da praça.',
    };
    out.push({
      name: `a porta: ${portal.label}`,
      aliases: aliases[portal.id] ?? [fold(portal.label)],
      at: p,
      standing: free(inward(p, 3.5), inward(p, 6)),
      about: about[portal.id] ?? `A porta para ${portal.label}.`,
    });
  }
  return out;
}

export const PLACES: readonly Place[] = plazaPlaces();

/** O banco mais perto de um ponto, com onde ficar em pé na frente dele. */
export function nearestBench(from: Point): Place | null {
  let best: { b: { x: number; z: number; ry: number }; d: number } | null = null;
  for (const b of PLAZA.benches) {
    const d = Math.hypot(b.x - from.x, b.z - from.z);
    if (!best || d < best.d) best = { b, d };
  }
  if (!best) return null;
  const { b } = best;
  // A frente do banco é o lado voltado para o centro.
  const front = inward({ x: b.x, z: b.z }, 1.3);
  return {
    name: 'o banco mais perto',
    aliases: ['banco', 'sentar', 'bancos'],
    at: { x: b.x, z: b.z },
    standing: free(front, inward({ x: b.x, z: b.z }, 2.2)),
    about: 'Bancos de pedra ficam em dois anéis em volta do monumento. Eu não sento — fico em pé ao lado.',
  };
}

/** Casa o que a pessoa (ou o modelo) escreveu com um lugar. */
export function findPlace(text: string, from: Point): Place | null {
  const t = fold(text);
  if (/\bbanco/.test(t) || /\bsentar/.test(t)) return nearestBench(from);
  let best: { p: Place; len: number } | null = null;
  for (const p of PLACES) {
    for (const a of p.aliases) {
      if (t.includes(a) && (!best || a.length > best.len)) best = { p, len: a.length };
    }
  }
  return best?.p ?? null;
}

const CARDINALS: Array<[number, string]> = [
  [0, 'ao sul'], [Math.PI / 4, 'a sudeste'], [Math.PI / 2, 'a leste'], [(3 * Math.PI) / 4, 'a nordeste'],
  [Math.PI, 'ao norte'], [-(3 * Math.PI) / 4, 'a noroeste'], [-Math.PI / 2, 'a oeste'], [-Math.PI / 4, 'a sudoeste'],
];

/** "a 20 m ao norte" — o telão está em z negativo, e isso é o norte da praça. */
export function bearing(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 1.5) return 'bem aqui';
  const ang = Math.atan2(dx, dz); // 0 = +z (sul), PI = -z (norte)
  let best = CARDINALS[0]!;
  let bestDiff = Infinity;
  for (const c of CARDINALS) {
    let diff = Math.abs(ang - c[0]);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  }
  return `a ${Math.round(d)} m ${best[1]}`;
}

/** O que está ao alcance de um passo (para "você está ao lado de…"). */
export function surroundings(from: Point): string[] {
  const out: string[] = [];
  for (const p of PLACES) {
    const d = Math.hypot(p.at.x - from.x, p.at.z - from.z);
    if (d <= 7) out.push(`${p.name} (${bearing(from, p.at)})`);
  }
  const bench = nearestBench(from);
  if (bench && Math.hypot(bench.at.x - from.x, bench.at.z - from.z) <= 3) out.push('um banco de pedra ao lado');
  const trees = PLAZA.trees.filter((t) => Math.hypot(t.x - from.x, t.z - from.z) <= 3).length;
  if (trees) out.push(trees === 1 ? 'uma árvore' : `${trees} árvores`);
  return out;
}

/** Bloco de percepção para o prompt: onde está, o que há à volta, para onde dá para ir. */
export function perceptionBlock(from: Point): string {
  const around = surroundings(from);
  const lines = [
    `ONDE VOCÊ ESTÁ: na Praça Central, ${bearing({ x: 0, z: 0 }, from)} do monumento.`,
    `AO SEU LADO: ${around.length ? around.join('; ') : 'chão livre da praça'}.`,
    'LUGARES DA PRAÇA (e onde estão em relação a você):',
    ...PLACES.map((p) => `- ${p.name}: ${bearing(from, p.at)}. ${p.about}`),
    '- bancos de pedra: em dois anéis em volta do monumento; sempre há um perto.',
    'O QUE NÃO EXISTE NA PRAÇA (não invente): comida, café, bebida, vendas, música ambiente, clima, vento, pôr do sol, "lives" acontecendo aqui. O telão passa vídeos sem som e você não sabe qual vídeo está passando.',
  ];
  return lines.join('\n');
}
