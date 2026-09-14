import { NOIR, PLAZA, PORTALS, SCENE_COLLIDERS, penetrates, type SceneId } from './shared.js';
import { nearestFree, SCENE_LABEL, weatherApplies } from './scenes.js';
import { formatClock, isNight, type Weather } from './shared.js';
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
    about: 'O telão passa em laço, sem som, um vídeo curto de um compositor. Na frente dele há uma clareira sem árvores.',
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

/**
 * O Distrito Sombra, com nome e lugar. As paradas dos bicos (`NOIR.stops`) já
 * são os lugares do bairro; aqui elas ganham apelido, um ponto para ficar em
 * pé (na calçada, fora da fachada) e um fato para não inventar.
 */
function noirPlaces(): Place[] {
  const id: SceneId = 'noir_district';
  const stand = (p: Point, towardStreet: number): Point => nearestFree(id, { x: p.x, z: p.z + towardStreet * 1.6 });
  const out: Place[] = [];
  const S = NOIR.stops;
  const def = (
    key: string, name: string, aliases: string[], about: string,
  ) => {
    const p = S[key];
    if (!p) return;
    const side = p.z < -10 ? 0 : p.z < 0 ? 1 : -1; // lado da rua: recua para o meio
    out.push({ name, aliases, at: { x: p.x, z: p.z }, standing: stand(p, side), about });
  };
  def('bar', 'o bar da esquina', ['bar', 'bar da esquina', 'esquina', 'bebida', 'cerveja'], 'Um bar com letreiro vermelho na ponta oeste da avenida. Está fechado: o néon acende, a porta não abre. Ninguém vende nada.');
  def('metro', 'a boca do metrô', ['metro', 'estacao', 'trem'], 'Uma escada que desce para uma estação que não existe: é só a boca, com letreiro azul. Não leva a lugar nenhum.');
  def('hotel', 'a portaria do hotel', ['hotel', 'portaria', 'hospedagem'], 'A portaria de um hotel de fachada, letreiro vermelho vertical. Não se entra.');
  def('cafe', 'o café da avenida', ['cafe', 'cafeteria', 'padaria'], 'Um café com letreiro azul, fechado como tudo aqui. Não tem café de verdade.');
  def('oficina', 'a oficina', ['oficina', 'mecanica', 'carro'], 'Uma oficina mecânica na calçada sul, portão fechado.');
  def('club', 'a porta do Clube Sombra', ['clube', 'club', 'clube sombra', 'balada', 'discoteca', 'festa', 'pista', 'dancar'], 'A porta do Clube Sombra, embaixo do néon "club". É a única porta do bairro que abre: lá dentro é uma discoteca com pista e DJ.');
  def('doca', 'a doca de carga', ['doca', 'carga', 'caminhao', 'galpao'], 'Uma doca de carga com letreiro amarelo, na calçada sul. Parada de bico.');
  def('loja', 'a loja de conveniência', ['loja', 'conveniencia', 'mercado', 'mercadinho'], 'Uma loja de conveniência de fachada, letreiro amarelo. Não vende nada — a loja de verdade é a Stream Store, na praça.');
  def('lavanderia', 'a lavanderia 24h', ['lavanderia', 'lava', 'roupa suja'], 'Uma lavanderia 24 horas com letreiro azul, na ponta leste. Parada de bico.');
  def('fundos', 'os fundos do beco', ['beco', 'fundos', 'tambor', 'fogueira', 'fogo'], 'O beco sem saída da fileira norte, com um tambor aceso no fundo. É o lugar mais escuro do bairro.');
  def('passagem_o', 'a passagem oeste', ['passagem oeste', 'passagem', 'travessa', 'atalho'], 'Uma passagem que atravessa da avenida para a travessa, o fundo do quarteirão.');
  def('passagem_l', 'a passagem leste', ['passagem leste'], 'A outra passagem para a travessa, do lado leste.');
  def('deposito', 'o depósito da travessa', ['deposito'], 'Um depósito na travessa, com letreiro amarelo. Parada de bico.');
  def('garagem', 'a garagem', ['garagem'], 'Uma garagem na travessa, letreiro azul.');
  def('clinica', 'a clínica noturna', ['clinica', 'medico', 'hospital'], 'Uma clínica noturna na travessa, letreiro vermelho. Fachada, só.');
  for (const portal of PORTALS.noir_district ?? []) {
    if (portal.id !== 'noir_exit') continue;
    out.push({
      name: 'a porta: Voltar à praça',
      aliases: ['praca', 'praca central', 'voltar', 'saida', 'portao', 'nilo', 'telao', 'monumento', 'torre', 'apartamento', 'stream store', 'agencia'],
      at: { x: portal.x, z: portal.z },
      standing: nearestFree(id, { x: portal.x + 4, z: portal.z }),
      about: 'O portão do bairro, na ponta oeste da avenida: dali se volta à Praça Central, onde ficam o telão, o monumento, a loja e as torres.',
    });
  }
  return out;
}

const BY_SCENE: Partial<Record<SceneId, readonly Place[]>> = {
  central_plaza: PLACES,
};

export function placesOf(scene: SceneId): readonly Place[] {
  let list = BY_SCENE[scene];
  if (!list) {
    list = scene === 'noir_district' ? noirPlaces() : exitPlaces(scene);
    BY_SCENE[scene] = list;
  }
  return list;
}

/** Interiores: o único lugar com nome é a saída. */
function exitPlaces(scene: SceneId): Place[] {
  const out: Place[] = [];
  for (const portal of PORTALS[scene] ?? []) {
    out.push({
      name: `a porta: ${portal.label}`,
      aliases: [fold(portal.label), 'saida', 'porta', 'sair', 'praca', 'rua'],
      at: { x: portal.x, z: portal.z },
      standing: nearestFree(scene, { x: portal.x, z: portal.z - 2.5 }),
      about: `A porta: ${portal.label}.`,
    });
  }
  return out;
}

/** O banco mais perto de um ponto, com onde ficar em pé na frente dele. Só a praça tem bancos. */
export function nearestBench(from: Point, scene: SceneId = 'central_plaza'): Place | null {
  if (scene !== 'central_plaza') return null;
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
    about: 'Bancos de pedra ficam em dois anéis em volta do monumento.',
  };
}

/** Casa o que a pessoa (ou o modelo) escreveu com um lugar da cena. */
export function findPlace(text: string, from: Point, scene: SceneId = 'central_plaza'): Place | null {
  const t = fold(text);
  if (scene === 'central_plaza' && (/\bbanco/.test(t) || /\bsentar/.test(t))) return nearestBench(from, scene);
  let best: { p: Place; len: number } | null = null;
  for (const p of placesOf(scene)) {
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
export function surroundings(from: Point, scene: SceneId = 'central_plaza'): string[] {
  const out: string[] = [];
  for (const p of placesOf(scene)) {
    const d = Math.hypot(p.at.x - from.x, p.at.z - from.z);
    if (d <= 7) out.push(`${p.name} (${bearing(from, p.at)})`);
  }
  if (scene === 'central_plaza') {
    const bench = nearestBench(from, scene);
    if (bench && Math.hypot(bench.at.x - from.x, bench.at.z - from.z) <= 3) out.push('um banco de pedra ao lado');
    const trees = PLAZA.trees.filter((t) => Math.hypot(t.x - from.x, t.z - from.z) <= 3).length;
    if (trees) out.push(trees === 1 ? 'uma árvore' : `${trees} árvores`);
  }
  if (scene === 'noir_district') {
    const lamps = NOIR.lamps.filter((l) => Math.hypot(l.x - from.x, l.z - from.z) <= 3).length;
    if (lamps) out.push('um poste aceso');
    if (Math.hypot(NOIR.barrel.x - from.x, NOIR.barrel.z - from.z) <= 4) out.push('o tambor aceso do beco');
  }
  return out;
}

/** Fatos fixos de cada cena para o prompt: o que há e o que NÃO há. */
const SCENE_FACTS: Partial<Record<SceneId, { where: (from: Point) => string; fixed: string[]; absent: string }>> = {
  central_plaza: {
    where: (from) => `na Praça Central, ${bearing({ x: 0, z: 0 }, from)} do monumento.`,
    fixed: [
      '- bancos de pedra: em dois anéis em volta do monumento; sempre há um perto.',
      'O TELÃO: passa em laço, sem som, um único vídeo curto de um compositor de música — o mesmo o dia inteiro, todo dia. É tudo o que você sabe dizer dele; nunca diga que "hoje tem algo novo".',
    ],
    absent: 'O QUE NÃO EXISTE NA PRAÇA (não invente): comida, café, bebida, vendas, música ambiente, vento, tempestade, raio, pôr do sol descrito além do que a hora diz, "lives" acontecendo aqui, gente sentada nos bancos que você não vê na lista de pessoas. O único fato de clima é o da linha CLIMA AGORA: nunca diga que chove se ela diz tempo aberto, nem o contrário.',
  },
  noir_district: {
    where: (from) => {
      const street = from.z < -25 ? 'na travessa (o fundo do quarteirão)' : from.z < -10 ? 'numa passagem ou no beco' : 'na avenida';
      return `no Distrito Sombra, ${street}, ${bearing({ x: -54.5, z: 0 }, from)} do portão do bairro.`;
    },
    fixed: [
      '- as duas ruas: a avenida (leste-oeste, 18 m de largura, com postes em ziguezague, poças e néons) e a travessa, paralela ao norte, mais estreita e escura. Duas passagens as ligam; um beco sem saída sai da avenida para o norte.',
      '- os bicos (PRD "trabalhos"): entregas a pé entre as paradas do bairro, pagas em Credits pelo jogo. Você não paga, não escolhe nem acompanha nenhum — só sabe que existem e onde ficam as paradas.',
      '- a chuva: é sempre noite e sempre chuvisca aqui; as poças refletem os néons. Isso é tudo o que há de clima.',
      '- o telão do bairro: na fachada sul da avenida, passa o mesmo vídeo em laço da praça, sem som.',
    ],
    absent: 'O QUE NÃO EXISTE NO BAIRRO (não invente): bar aberto, bebida, comida, carros andando, metrô funcionando, polícia, briga, drogas, gente dentro dos prédios, lojas que vendem alguma coisa. Todas as fachadas são fechadas; a única porta que abre é a do Clube Sombra.',
  },
};

/** Bloco de percepção para o prompt: onde está, o que há à volta, para onde dá para ir. */
/**
 * O clima como FATO para o prompt. Só onde o clima do mundo é desenhado (a
 * praça); no Distrito Sombra chuvisca sempre por desenho e isso já está nos
 * fatos fixos. Sem clima conhecido (antes da primeira escrita da sala) a
 * linha diz isso — melhor "não sei" do que o modelo escolher.
 */
export function weatherLine(scene: SceneId, weather: Weather | null, minutes: number | null): string {
  if (!weatherApplies(scene)) return '';
  const when = minutes === null ? '' : ` Hora do relógio da cidade: ${formatClock(minutes)} (${isNight(minutes) ? 'noite' : 'dia'}; o dia da cidade passa mais rápido que o de Brasília).`;
  if (weather === 'rain') return `CLIMA AGORA: está CHOVENDO na praça — chuva fina e contínua, sem trovoada, sem vento, sem tempestade. As pessoas se abrigam sob as copas, os toldos dos quiosques e as marquises das portas.${when}`;
  if (weather === 'clear') return `CLIMA AGORA: tempo ABERTO, sem chuva.${when}`;
  return `CLIMA AGORA: você ainda não reparou no tempo; se perguntarem, diga que não olhou.${when}`;
}

export function perceptionBlock(from: Point, scene: SceneId = 'central_plaza', weather: Weather | null = null, minutes: number | null = null): string {
  const facts = SCENE_FACTS[scene];
  const around = surroundings(from, scene);
  const label = SCENE_LABEL[scene];
  const climate = weatherLine(scene, weather, minutes);
  const lines = [
    `ONDE VOCÊ ESTÁ: ${facts ? facts.where(from) : `em ${label}.`}`,
    ...(climate ? [climate] : []),
    `AO SEU LADO: ${around.length ? around.join('; ') : 'chão livre'}.`,
    `LUGARES DE ${label.toUpperCase()} (e onde estão em relação a você):`,
    ...placesOf(scene).map((p) => `- ${p.name}: ${bearing(from, p.at)}. ${p.about}`),
    ...(facts?.fixed ?? []),
    facts?.absent ?? 'Não invente lugares, objetos ou pessoas que não estejam nesta lista.',
  ];
  return lines.join('\n');
}
