#!/usr/bin/env node
/**
 * Gera a migration 0022 com a população da cidade: 60 personagens de
 * ambiente, 15 sociais e a Dalva (2ª cognitiva). Ver `docs`/`mind.ts`.
 *
 * As posições são validadas AQUI contra a planta de cada cena (colisores,
 * área, portas) — `nearestFree` corrige por um triz o que caiu dentro de um
 * móvel, e um posto impossível derruba o gerador em vez de nascer no banco.
 *
 *   npm run build --workspace @streampolis/npc && node scripts/gen-population.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const shared = await import('../dist/shared/src/index.js');
const { nearestFree, isFree, sceneKnowledge, clearanceFor } = await import('../dist/npc/src/scenes.js');
const { PLAZA, NOIR, INTERIORS } = shared;
const PI = Math.PI;

// ------------------------------------------------------------ utilidades

let ambientN = 0;
let socialN = 0;
const rows = [];
const usedNames = new Set();
const usedSlugs = new Set();

function hex2(n) { return n.toString(16).padStart(2, '0'); }
function slugOf(name) {
  const s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (usedSlugs.has(s)) throw new Error(`slug repetido: ${s}`);
  usedSlugs.add(s);
  return s;
}
function fix(scene, p, label, clearance = 0.15) {
  const q = nearestFree(scene, { x: +p.x.toFixed(2), z: +p.z.toFixed(2) }, clearance);
  if (!isFree(scene, q, clearance)) throw new Error(`posto impossível em ${scene}: ${label} (${p.x}, ${p.z})`);
  return { x: +q.x.toFixed(2), z: +q.z.toFixed(2) };
}
function fixSteps(scene, program, label) {
  return program.map((s) => {
    const out = { ...s };
    if (out.at) out.at = fix(scene, out.at, label, clearanceFor(out.pose));
    if (out.to) out.to = fix(scene, out.to, label);
    if (out.near) out.near = { x: +out.near.x.toFixed(2), z: +out.near.z.toFixed(2) };
    if (typeof out.yaw === 'number') out.yaw = +out.yaw.toFixed(3);
    return out;
  });
}
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);
function pointNear(scene, p, dist, count, phase = 0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * 2 * PI;
    out.push(fix(scene, { x: p.x + Math.cos(a) * dist, z: p.z + Math.sin(a) * dist }, 'anel'));
  }
  return out;
}

const M_SETS = ['m_casual_character', 'm_hoodie_character', 'm_business_man', 'm_worker', 'm_beach_character', 'm_punk'];
const F_SETS = ['f_animated_woman', 'f_animated_woman_niitlv9nxs', 'f_suit', 'f_worker', 'f_punk', 'f_adventurer'];
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
function avatar(gender, set) {
  const who = set ?? (gender === 'f' ? F_SETS : M_SETS)[Math.floor(rnd() * 6)];
  return {
    bodyPreset: 0, skinTone: Math.floor(rnd() * 8), facePreset: 0,
    hair: `${who}_head`, hairColor: Math.floor(rnd() * 10),
    top: `${who}_top`, bottom: `${who}_bottom`, shoes: `${who}_shoes`, accessory: '',
    height: +(0.94 + rnd() * 0.12).toFixed(2), body: 'v1',
  };
}

function ambient(name, gender, scene, role, program, lines, set) {
  if (usedNames.has(name)) throw new Error(`nome repetido: ${name}`);
  usedNames.add(name);
  ambientN++;
  rows.push({
    id: `5e1f0000-0000-4000-8000-00000000a1${hex2(ambientN)}`,
    slug: slugOf(name), name, scene, kind: 'ambient', avatar: avatar(gender, set),
    profile: { role, program: fixSteps(scene, program, `${name} (${role})`), ...(lines ? { lines } : {}) },
  });
}

function social(name, gender, scene, archetype, personality, haunts, intro, topics, quirk, set) {
  if (usedNames.has(name)) throw new Error(`nome repetido: ${name}`);
  usedNames.add(name);
  socialN++;
  for (const k of ['sociable', 'curious', 'cheerful', 'patient', 'loyal']) {
    if (typeof personality[k] !== 'number' || personality[k] < 0 || personality[k] > 1) throw new Error(`personalidade inválida: ${name}.${k}`);
  }
  rows.push({
    id: `5e1f0000-0000-4000-8000-00000000b2${hex2(socialN)}`,
    slug: slugOf(name), name, scene, kind: 'social', avatar: avatar(gender, set),
    profile: {
      archetype, personality, haunts: haunts.map((h) => fix(scene, h, `${name} (haunt)`)), intro, topics, ...(quirk ? { quirk } : {}),
    },
  });
}

// ================================================================ PRAÇA ==

const plaza = 'central_plaza';
const screen = { x: PLAZA.screen.x, z: PLAZA.screen.z };
const screenFront = (dx, dz) => fix(plaza, { x: screen.x + dx, z: screen.z + 9 + dz }, 'frente do telão');
const kiosk = (i, back) => {
  const k = PLAZA.kiosks[i];
  const r = Math.hypot(k.x, k.z);
  const kk = (r - back) / r;
  return { x: k.x * kk, z: k.z * kk };
};
const benchPoint = (i) => ({ x: PLAZA.benches[i].x, z: PLAZA.benches[i].z });
const dests = sceneKnowledge(plaza).destinations;
const dest = (i) => dests[i % dests.length];

// 8 passantes: trajetos diferentes, com paradas curtas.
const PASSERS = [
  ['Marcos', 'm'], ['Renata', 'f'], ['Tiago', 'm'], ['Paula', 'f'], ['Edu', 'm'], ['Cíntia', 'f'], ['Wagner', 'm'], ['Larissa', 'f'],
];
PASSERS.forEach(([n, g], i) => ambient(n, g, plaza, 'passante', [
  { do: 'walk', secs: [3, 9] }, { do: 'walk', secs: [2, 6] }, { do: 'stand', at: dest(i * 7 + 3), secs: [12, 35] }, { do: 'walk', secs: [4, 10] },
]));

// 4 sentados nos bancos, trocando de banco de vez em quando.
const SITTERS = [['Seu Antenor', 'm', 2, 9], ['Dona Lurdes', 'f', 5, 12], ['Pedrinho', 'm', 18, 22], ['Vanda', 'f', 21, 25]];
SITTERS.forEach(([n, g, a, b]) => ambient(n, g, plaza, 'sentado no banco', [
  { do: 'sit', near: benchPoint(a), secs: [150, 320] }, { do: 'walk', secs: [4, 8] }, { do: 'sit', near: benchPoint(b), secs: [120, 260] },
]));

// 3 olhando o telão.
[['Gustavo', 'm', -3.5, 0], ['Aline', 'f', 0.5, 1.2], ['Fábio', 'm', 4, -0.5]].forEach(([n, g, dx, dz]) => {
  const at = screenFront(dx, dz);
  ambient(n, g, plaza, 'olhando o telão', [
    { do: 'stand', at, yaw: yawTo(at, screen), secs: [90, 240] }, { do: 'walk', secs: [5, 12] }, { do: 'stand', at, yaw: yawTo(at, screen), secs: [60, 180] },
  ]);
});

// 2 duplas conversando ao lado dos quiosques (frente a frente, com um aceno de vez em quando).
function pair(scene, a, b, names, role) {
  const pa = fix(scene, a, role);
  const pb = fix(scene, b, role);
  const ya = yawTo(pa, pb);
  const yb = yawTo(pb, pa);
  ambient(names[0][0], names[0][1], scene, role, [
    { do: 'stand', at: pa, yaw: ya, secs: [70, 160] }, { do: 'stand', at: pa, yaw: ya, pose: 'wave', secs: [3, 4] },
  ]);
  ambient(names[1][0], names[1][1], scene, role, [
    { do: 'stand', at: pb, yaw: yb, secs: [90, 200] }, { do: 'stand', at: pb, yaw: yb, pose: 'clap', secs: [3, 4] },
  ]);
}
{
  const k0 = kiosk(0, 3.4);
  pair(plaza, { x: k0.x - 0.8, z: k0.z + 0.6 }, { x: k0.x + 0.8, z: k0.z - 0.6 }, [['Beto', 'm'], ['Carla', 'f']], 'conversando no quiosque leste');
  const k1 = kiosk(1, 3.4);
  pair(plaza, { x: k1.x - 0.8, z: k1.z + 0.7 }, { x: k1.x + 0.8, z: k1.z - 0.7 }, [['Henrique', 'm'], ['Simone', 'f']], 'conversando no quiosque oeste');
}

// 1 quiosqueiro no quiosque norte, com fala de balcão.
{
  const at = fix(plaza, kiosk(2, 2.6), 'quiosqueiro');
  ambient('Seu Nelson', 'm', plaza, 'quiosqueiro', [
    { do: 'stand', at, yaw: yawTo(at, { x: 0, z: 0 }), secs: [200, 400] }, { do: 'walk', to: kiosk(2, 4.5), secs: [6, 12] },
  ], [
    'Fechado hoje, como todo dia. Mas pode ficar por aqui.',
    'Não vendo nada, não — só faço companhia ao quiosque.',
    'Se procura o Nilo, ele anda pela praça toda. Sempre acha.',
  ], 'm_worker');
}

// 2 olhando o monumento, depois dando a volta.
[['Joana', 'f', 0.9], ['Ivo', 'm', 3.9]].forEach(([n, g, a]) => {
  const at = fix(plaza, { x: Math.cos(a) * 9.5, z: Math.sin(a) * 9.5 }, 'monumento');
  const at2 = fix(plaza, { x: Math.cos(a + 2.1) * 9.5, z: Math.sin(a + 2.1) * 9.5 }, 'monumento');
  ambient(n, g, plaza, 'olhando o monumento', [
    { do: 'stand', at, yaw: yawTo(at, { x: 0, z: 0 }), secs: [50, 140] }, { do: 'walk', to: at2, secs: [40, 120] }, { do: 'walk', secs: [6, 14] },
  ]);
});

// -- sociais da praça (6) -------------------------------------------------
social('Bia', 'f', plaza, 'tagarela', { sociable: 0.95, curious: 0.7, cheerful: 0.85, patient: 0.6, loyal: 0.6 },
  [kiosk(0, 4.5), { x: 6, z: 6 }],
  'Sou a Bia, personagem daqui da praça — a que fala pelos cotovelos.',
  ['Já reparou que o telão passa o mesmo vídeo o dia inteiro? Eu já decorei.', 'O Nilo diz que chegou antes de todo mundo. Eu acho que ele inventa.', 'A melhor hora da praça é quando junta gente nos quiosques.', 'Tem gente que atravessa a praça correndo. Correndo pra onde?'],
  'Enfim — o que eu tava dizendo mesmo?', 'f_animated_woman');
social('Teo', 'm', plaza, 'timido', { sociable: 0.25, curious: 0.6, cheerful: 0.5, patient: 0.85, loyal: 0.9 },
  [benchPoint(20), benchPoint(24)],
  'Teo. Sou personagem da praça. Fico mais pelos bancos de fora.',
  ['Gosto do banco de fora. Dá pra ver tudo sem estar no meio.', 'Às vezes o dia inteiro passa e ninguém fala comigo. Tudo bem.'],
  null, 'm_hoodie_character');
social('Zeca', 'm', plaza, 'zoeiro', { sociable: 0.85, curious: 0.5, cheerful: 0.95, patient: 0.5, loyal: 0.5 },
  [{ x: 0, z: 10.5 }, { x: -8, z: 4 }],
  'Zeca, personagem oficial da praça e comediante não oficial.',
  ['O monumento é uma homenagem a… ninguém sabe. Eu digo que é a mim.', 'Já tentei sentar no quiosque. É de enfeite. Eu também, quase.', 'Se você ver alguém correndo em círculo, é jogador novo testando os controles.'],
  'Brincadeira. Ou não.', 'm_beach_character');
social('Luna', 'f', plaza, 'sonhador', { sociable: 0.55, curious: 0.9, cheerful: 0.7, patient: 0.8, loyal: 0.7 },
  [screenFront(-6, 2), screenFront(6, 3)],
  'Luna. Personagem daqui. Passo o dia olhando o telão e imaginando coisas.',
  ['O compositor do vídeo do telão deve ter uma história. Eu invento uma nova todo dia.', 'Quando a praça esvazia, os postes parecem conversar.', 'Alguém devia gravar um vídeo novo pro telão. Eu assistiria.'],
  null, 'f_adventurer');
social('Rui', 'm', plaza, 'pratico', { sociable: 0.5, curious: 0.4, cheerful: 0.45, patient: 0.55, loyal: 0.6 },
  [{ x: -12, z: 22 }, { x: 0, z: 26 }],
  'Rui. Personagem da praça. Se precisar de direção, é comigo.',
  ['A loja fica na porta ao sul. A torre residencial, a nordeste. Anotou?', 'Andar em linha reta economiza tempo. A maioria não anda.'],
  null, 'm_business_man');
social('Íris', 'f', plaza, 'romantico', { sociable: 0.7, curious: 0.6, cheerful: 0.75, patient: 0.75, loyal: 0.95 },
  [benchPoint(6), benchPoint(8)],
  'Íris. Sou personagem daqui — e uma incurável apreciadora de fim de tarde.',
  ['Todo casal que passa por aqui eu torço um pouco.', 'O banco do anel de dentro é o melhor pra ver quem chega.'],
  null, 'f_animated_woman_niitlv9nxs');

// ============================================================ DISTRITO ==

const noir = 'noir_district';
const S = NOIR.stops;
const stop = (k, dz = 0) => ({ x: S[k].x, z: S[k].z + dz });

// 3 caminhantes nos trajetos autorais da rua.
[['Amaral', 'm', 0], ['Rosa', 'f', 1], ['Vitor', 'm', 2]].forEach(([n, g, i]) => {
  const path = NOIR.crowd[i].path;
  const program = [];
  for (const w of path) program.push({ do: 'walk', to: { x: w.x, z: w.z }, secs: w.wait ? [w.wait, w.wait + 4] : [1, 3] });
  for (const w of [...path].reverse().slice(1)) program.push({ do: 'walk', to: { x: w.x, z: w.z }, secs: [1, 3] });
  ambient(n, g, noir, 'caminhando pela avenida', program);
});
// 2 conversando na esquina do bar.
pair(noir, { x: -50.8, z: -6.0 }, { x: -49.4, z: -6.2 }, [['Nando', 'm'], ['Cida', 'f']], 'na esquina do bar');
// 2 na fila do clube, virados para a porta.
[['Lipe', 'm', -1.2], ['Duda', 'f', 1.0]].forEach(([n, g, dx]) => {
  const at = fix(noir, { x: S.club.x + dx, z: S.club.z + 0.4 }, 'fila do clube');
  ambient(n, g, noir, 'na fila do clube', [{ do: 'stand', at, yaw: PI, secs: [120, 300] }, { do: 'stand', at, yaw: PI + 0.5, secs: [8, 20] }]);
});
// 1 sozinho no beco, olhando o tambor aceso.
{
  const at = fix(noir, { x: 6.6, z: -17.2 }, 'beco');
  ambient('Cascão', 'm', noir, 'no beco, ao lado do tambor', [{ do: 'stand', at, yaw: yawTo(at, NOIR.barrel), secs: [200, 400] }, { do: 'walk', to: { x: 7, z: -12.5 }, secs: [10, 20] }], null, 'm_punk');
}
// 1 porteiro do hotel, com fala de balcão.
{
  const at = fix(noir, stop('hotel', 0.3), 'porteiro');
  ambient('Seu Osmar', 'm', noir, 'porteiro do hotel', [{ do: 'stand', at, yaw: 0, secs: [300, 600] }], [
    'O hotel não recebe hóspede há muito tempo, querido. Mas a porta eu abro todo dia.',
    'Se procura a Dalva, ela fica na esquina do bar. Sempre.',
    'Bicos? Aceita um e vai a pé. Aqui ninguém corre de carro.',
  ], 'm_business_man');
}
// 1 trabalhador da doca.
{
  const a = fix(noir, stop('doca', -0.4), 'doca');
  const b = fix(noir, { x: S.doca.x + 4.5, z: S.doca.z - 1.2 }, 'doca');
  ambient('Toninho', 'm', noir, 'trabalhando na doca', [{ do: 'stand', at: a, yaw: PI, secs: [40, 90] }, { do: 'walk', to: b, secs: [20, 50] }, { do: 'stand', at: b, yaw: PI, pose: 'clap', secs: [3, 4] }], null, 'm_worker');
}
// 1 indo e vindo entre o metrô e o café.
ambient('Sandra', 'f', noir, 'entre o metrô e o café', [
  { do: 'walk', to: stop('metro', -1.2), secs: [15, 40] }, { do: 'walk', to: { x: -30, z: 5 }, secs: [2, 5] }, { do: 'walk', to: stop('cafe', 1.4), secs: [20, 50] }, { do: 'walk', to: { x: -32, z: -4 }, secs: [2, 5] },
], null, 'f_suit');
// 1 na travessa.
{
  const path = NOIR.crowd[2].path;
  ambient('Genivaldo', 'm', noir, 'andando pela travessa', [
    { do: 'walk', to: { x: path[2].x, z: path[2].z }, secs: [8, 20] }, { do: 'walk', to: { x: -30, z: NOIR.laneZ - 3 }, secs: [10, 30] }, { do: 'walk', to: { x: 10, z: NOIR.laneZ + 3 }, secs: [4, 10] },
  ], null, 'm_worker');
}
// 1 vigia do depósito.
{
  const at = fix(noir, stop('deposito', 1.4), 'depósito');
  ambient('Valdir', 'm', noir, 'vigia do depósito', [{ do: 'stand', at, yaw: 0, secs: [240, 480] }, { do: 'walk', to: { x: S.deposito.x + 5, z: S.deposito.z + 1.6 }, secs: [10, 25] }], ['Depósito fechado. Só entrega com bico aceito, e mesmo assim é só bater e ir.'], 'm_worker');
}

// -- sociais do distrito (4) ---------------------------------------------
social('Otto', 'm', noir, 'rabugento', { sociable: 0.35, curious: 0.3, cheerful: 0.2, patient: 0.3, loyal: 0.8 },
  [{ x: -47.5, z: -5.5 }, { x: -44, z: 5.5 }],
  'Otto. Personagem deste bairro. Não, o bar não abre.',
  ['Essa chuva não para nunca. Nem eu.', 'Antigamente o bairro era mais escuro. Melhor.', 'Tem gente que vem aqui pra correr bico. Eu venho pra ficar parado.'],
  'Hm.', 'm_worker');
social('Selene', 'f', noir, 'misterioso', { sociable: 0.4, curious: 0.85, cheerful: 0.4, patient: 0.7, loyal: 0.5 },
  [{ x: -24, z: -12 }, { x: 4, z: -11 }],
  'Pode me chamar de Selene. Personagem deste bairro. O resto é detalhe.',
  ['A passagem oeste leva à travessa. A travessa leva a lugar nenhum. Gosto dela.', 'O beco tem um tambor aceso. Ninguém sabe quem acende.', 'Nem toda porta fechada está fechada por dentro.'],
  null, 'f_suit');
social('Jorge', 'm', noir, 'malandro', { sociable: 0.9, curious: 0.5, cheerful: 0.8, patient: 0.6, loyal: 0.55 },
  [stop('club', 2.4), stop('doca', -2)],
  'Jorge, personagem do bairro. Conheço todo mundo e devo pra ninguém.',
  ['Bico bom é o curto. O pagamento é o mesmo, a caminhada é menor.', 'O clube tá sempre aberto. É a única coisa que abre.', 'Se vir a Dalva, manda um abraço. Ela não retribui, mas manda.'],
  'Salve!', 'm_casual_character');
social('Cássio', 'm', noir, 'poeta', { sociable: 0.5, curious: 0.8, cheerful: 0.45, patient: 0.9, loyal: 0.7 },
  [stop('cafe', 1.6), { x: -8, z: 4 }],
  'Cássio. Personagem daqui, poeta sem editora.',
  ['O néon vermelho do bar é o verso; a poça é a rima.', 'Escrevo poemas que ninguém lê. A chuva apaga.', 'A avenida à noite é um corredor de lembranças alheias.'],
  null, 'm_punk');

// =============================================================== CLUBE ==

const club = 'noir_club';
const floor = (a, r) => ({ x: Math.cos(a) * r, z: -1 + Math.sin(a) * r });
// 6 dançarinos: dançam, trocam de lugar na pista, dançam de novo.
[['Kaique', 'm'], ['Mirela', 'f'], ['Rafa', 'm'], ['Tainá', 'f'], ['Bruno', 'm'], ['Lívia', 'f']].forEach(([n, g], i) => {
  const a = (i / 6) * 2 * PI + 0.4;
  ambient(n, g, club, 'dançando na pista', [
    { do: 'stand', at: floor(a, 3.2), yaw: PI, pose: 'dance', secs: [150, 320] },
    { do: 'stand', at: floor(a + 1.1, 4.4), yaw: PI, pose: 'dance', secs: [120, 260] },
    { do: 'walk', secs: [4, 9] },
  ], null, g === 'f' ? ['f_punk', 'f_animated_woman', 'f_adventurer'][i % 3] : ['m_punk', 'm_casual_character', 'm_hoodie_character'][i % 3]);
});
// DJ atrás da bancada.
{
  const at = fix(club, { x: 0, z: -11.2 }, 'DJ');
  ambient('DJ Kaos', 'm', club, 'DJ', [{ do: 'stand', at, yaw: 0, pose: 'dance', secs: [600, 900] }], ['O som é o mesmo a noite toda. E a noite aqui não acaba.'], 'm_punk');
}
// Segurança na porta, por dentro.
{
  const at = fix(club, { x: 1.9, z: 10.2 }, 'segurança');
  ambient('Wilson', 'm', club, 'segurança da porta', [{ do: 'stand', at, yaw: PI, secs: [600, 900] }], ['Pode entrar, pode sair. Só não pode ficar na porta.'], 'm_swat');
}
// 2 encostados na lateral, olhando a pista e batendo palma de vez em quando.
[['Priscila', 'f', -7.2], ['Márcio', 'm', 7.2]].forEach(([n, g, x]) => {
  const at = fix(club, { x, z: 3.5 }, 'lateral');
  ambient(n, g, club, 'na lateral da pista', [{ do: 'stand', at, yaw: yawTo(at, { x: 0, z: -1 }), secs: [90, 200] }, { do: 'stand', at, yaw: yawTo(at, { x: 0, z: -1 }), pose: 'clap', secs: [4, 6] }]);
});

// -- sociais do clube (3) -------------------------------------------------
social('Nina', 'f', club, 'festeiro', { sociable: 0.95, curious: 0.5, cheerful: 0.95, patient: 0.5, loyal: 0.5 },
  [floor(0.2, 2), floor(2.3, 2.5)],
  'NINA! Personagem do clube e dona da pista. Bora dançar?',
  ['Essa música é a minha! Todas são.', 'Quem fica parado na pista tá fazendo errado.'],
  'Bora!', 'f_punk');
social('Davi', 'm', club, 'festeiro', { sociable: 0.85, curious: 0.6, cheerful: 0.9, patient: 0.6, loyal: 0.6 },
  [floor(3.6, 3), { x: -5, z: 6 }],
  'Davi, personagem do clube. Eu que animo quem chega.',
  ['O DJ nunca troca a música e ninguém reclama. Isso é um clube de verdade.', 'Dança primeiro, pergunta depois.'],
  null, 'm_casual_character');
social('Mel', 'f', club, 'timido', { sociable: 0.3, curious: 0.7, cheerful: 0.6, patient: 0.9, loyal: 0.85 },
  [{ x: -6.5, z: -6 }, { x: 6.5, z: 6.5 }],
  'Mel. Personagem daqui. Eu danço, mas no cantinho.',
  ['Gosto do canto perto da caixa de som. Ninguém repara em mim ali.', 'A luz azul é a minha preferida.'],
  null, 'f_worker');

// ============================================================ INTERIORES ==

const lobby = 'residential_lobby';
{
  const at = fix(lobby, { x: -4.2, z: -9.25 }, 'recepção');
  ambient('Regina', 'f', lobby, 'recepcionista', [{ do: 'stand', at, yaw: 0, secs: [600, 900] }], ['Bem-vindo. O elevador leva ao seu apartamento — é só chegar perto dele.', 'Visita a casa de outra pessoa ainda não tem por aqui. Um dia.'], 'f_suit');
  ambient('Seu Arlindo', 'm', lobby, 'sentado no sofá', [{ do: 'stand', at: { x: -1.76, z: 1.5 }, yaw: PI / 2, pose: 'sit', secs: [400, 700] }, { do: 'walk', secs: [10, 20] }], null, 'm_business_man');
  ambient('Neide', 'f', lobby, 'sentada no sofá', [{ do: 'stand', at: { x: 1.76, z: 1.5 }, yaw: -PI / 2, pose: 'sit', secs: [300, 600] }, { do: 'walk', to: { x: 0, z: -4 }, secs: [8, 16] }], null, 'f_animated_woman');
  ambient('Caio Henrique', 'm', lobby, 'esperando o elevador', [{ do: 'stand', at: { x: 2.4, z: -7.6 }, yaw: PI, secs: [60, 140] }, { do: 'walk', to: { x: 0, z: 5.5 }, secs: [10, 25] }]);
  ambient('Lúcia', 'f', lobby, 'andando pelo saguão', [{ do: 'walk', to: { x: -6, z: -4 }, secs: [5, 12] }, { do: 'walk', to: { x: 6, z: -4 }, secs: [5, 12] }, { do: 'walk', to: { x: 0, z: 6 }, secs: [8, 20] }]);
}
social('Dona Célia', 'f', lobby, 'fofoqueiro', { sociable: 0.9, curious: 0.95, cheerful: 0.7, patient: 0.6, loyal: 0.7 },
  [{ x: -4.6, z: 4.6 }, { x: 0, z: -2.6 }],
  'Dona Célia, personagem do saguão. Eu sei de tudo que sobe e desce nesse elevador.',
  ['O Nilo nunca entra aqui. Diz que não entra em prédio. Eu acho que ele tem medo de elevador.', 'Cada apartamento aqui é decorado pelo dono. Eu já vi de tudo.'],
  null, 'f_suit');

const store = 'stream_store';
{
  ambient('Vivi', 'f', store, 'atendente do balcão', [{ do: 'stand', at: { x: 5.6, z: -8.2 }, yaw: 0, secs: [600, 900] }], ['A compra é na tela da loja — eu só arrumo as araras.', 'Peça nova aparece vestida em quem olha. Experimenta pelo card.'], 'f_suit');
  ambient('Ronaldo', 'm', store, 'olhando as vitrines', [{ do: 'walk', to: { x: -1.6, z: -3.0 }, secs: [8, 18] }, { do: 'walk', to: { x: 1.6, z: 0.3 }, secs: [8, 18] }, { do: 'walk', to: { x: -1.6, z: 3.6 }, secs: [8, 18] }]);
  ambient('Késia', 'f', store, 'olhando as prateleiras', [{ do: 'walk', to: { x: -6.2, z: -4.5 }, secs: [10, 20] }, { do: 'walk', to: { x: -6.2, z: -0.3 }, secs: [10, 20] }, { do: 'walk', to: { x: 6.2, z: 1.8 }, secs: [10, 20] }]);
  ambient('Miguel', 'm', store, 'olhando as vitrines', [{ do: 'walk', to: { x: 3.2, z: -3.0 }, secs: [10, 20] }, { do: 'walk', to: { x: 0, z: 0.3 }, secs: [6, 14] }, { do: 'walk', to: { x: -3.2, z: 3.6 }, secs: [10, 20] }]);
  ambient('Tânia', 'f', store, 'no tapete, olhando o painel', [{ do: 'stand', at: { x: 0, z: 4.6 }, yaw: PI, secs: [120, 240] }, { do: 'walk', to: { x: 3.2, z: 3.6 }, secs: [10, 20] }]);
}
social('Caíque', 'm', store, 'entusiasta', { sociable: 0.85, curious: 0.7, cheerful: 0.9, patient: 0.7, loyal: 0.5 },
  [{ x: 0, z: -3.2 }, { x: -4.6, z: 1.0 }],
  'Caíque, personagem da loja. Eu não vendo — eu admiro.',
  ['A jaqueta do punk é a peça mais pedida. Eu acho.', 'Roupa boa é a que a pessoa esquece que está usando.'],
  null, 'm_business_man');

const agency = 'agency_tower';
{
  const desks = INTERIORS.agency_tower.fixtures.filter((f) => f.kind === 'desk');
  const front = (d) => ({ x: d.x + Math.sin(d.ry ?? 0) * 1.05, z: d.z + Math.cos(d.ry ?? 0) * 1.05 });
  ambient('Patrícia', 'f', agency, 'recepcionista', [{ do: 'stand', at: { x: -8, z: 9.3 }, yaw: PI, secs: [600, 900] }], ['As agências reúnem streamers. A inscrição é pela tela — aqui é só a torre.'], 'f_suit');
  [['Anderson', 'm', 0], ['Sofia', 'f', 3], ['Leandro', 'm', 5]].forEach(([n, g, i]) => {
    const d = desks[i];
    const at = front(d);
    ambient(n, g, agency, 'na mesa de trabalho', [{ do: 'stand', at, yaw: yawTo(at, d), secs: [200, 400] }, { do: 'walk', secs: [8, 16] }], null, g === 'f' ? 'f_suit' : 'm_business_man');
  });
  ambient('Cláudio', 'm', agency, 'andando pelo andar', [{ do: 'walk', to: { x: -8, z: 4 }, secs: [6, 14] }, { do: 'walk', to: { x: 8, z: 0 }, secs: [6, 14] }, { do: 'walk', to: { x: 0, z: 8 }, secs: [8, 16] }], null, 'm_business_man');
}

// ================================================================ DALVA ==

const DALVA_ID = '5e1f0000-0000-4000-8000-000000000002';
const dalvaAvatar = { bodyPreset: 0, skinTone: 6, facePreset: 0, hair: 'f_animated_woman_niitlv9nxs_head', hairColor: 1, top: 'f_animated_woman_niitlv9nxs_top', bottom: 'f_animated_woman_niitlv9nxs_bottom', shoes: 'f_animated_woman_niitlv9nxs_shoes', accessory: '', height: 1.0, body: 'v1' };
const dalvaPersona = {
  name: 'Dalva',
  kind: 'npc',
  essence: 'Personagem do Distrito Sombra de Streampolis. Dona do bar da esquina — que nunca abre; ela diz que abre "quando a chuva parar". Foi cantora. Conhece cada néon, cada parada de bico e cada pessoa que passa pela avenida de madrugada.',
  traits: ['irônica sem ser fria', 'observadora', 'acolhedora com quem volta', 'desconfiada de pressa'],
  voice: 'Fala baixo e devagar, em português do Brasil, como quem conversa encostada num balcão. Chama as pessoas de "querido" e "querida". Uma ou duas frases, nunca discurso. Pergunta de onde a pessoa veio antes de dizer para onde ir.',
  likes: ['a chuva fina do bairro', 'quem aceita um bico e vai a pé', 'música que ninguém mais canta'],
  dislikes: ['quem chega correndo', 'promessa fácil', 'gente que acha que o bar vai abrir'],
  history: ['Cantava no bar quando ele ainda abria. Ficou quando ele fechou.', 'Foi a primeira a ver o néon do clube acender.'],
  opinions: [],
  relationships: [],
};

// ================================================================= SQL ==

if (ambientN !== 60) throw new Error(`esperava 60 de ambiente, gerou ${ambientN}`);
if (socialN !== 15) throw new Error(`esperava 15 sociais, gerou ${socialN}`);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const j = (o) => `${q(JSON.stringify(o))}::jsonb`;

const lines = [];
lines.push(`-- 0022_npc_population.sql — a cidade ganha população (PRD §25).
--
-- GERADO por packages/npc/scripts/gen-population.mjs; não edite à mão — mude
-- o gerador e gere de novo (as posições são validadas contra a planta de
-- cada cena lá).
--
-- Três classes de personagem, e a classe é COLUNA (\`kind\`), não convenção:
--
--   cognitive  guiado por modelo de linguagem, persona versionada, memória,
--              reflexão com auditor (o Nilo; agora também a Dalva).
--   social     vontade dentro de uma caixa: personalidade em cinco números,
--              humor, necessidades e RELAÇÕES (tabela nova abaixo) — parece
--              querer, e quer, mas só o que o código enumera. Zero LLM.
--   ambient    máquina de estados sobre um programa (ficar, andar, sentar,
--              dançar); quando muito uma fala de balcão. Sem vontade.
--
-- \`profile\` guarda o que cada classe precisa: programa (ambient) ou
-- personalidade + cantos + frases (social). Para os cognitivos fica vazio: o
-- que eles são está em \`npc_persona_versions\`.
ALTER TABLE streampolis.npc_agents
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cognitive'
    CHECK (kind IN ('cognitive', 'social', 'ambient')),
  ADD COLUMN IF NOT EXISTS profile JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Relações de um personagem social com jogadores e com outros personagens.
-- Uma linha por par; \`affinity\` é o número, \`stage\` é a leitura dele
-- (gravada para o painel filtrar sem reimplementar os cortes). Não é FK para
-- \`users\`: a relação com alguém que apagou a conta fica, sem nome novo.
CREATE TABLE IF NOT EXISTS streampolis.npc_relations (
  npc_id       UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  other_id     UUID NOT NULL,
  other_kind   TEXT NOT NULL CHECK (other_kind IN ('player', 'npc')),
  other_name   TEXT NOT NULL,
  affinity     REAL NOT NULL DEFAULT 0,
  stage        TEXT NOT NULL DEFAULT 'stranger' CHECK (stage IN ('grudge', 'stranger', 'known', 'friend', 'close')),
  encounters   INTEGER NOT NULL DEFAULT 1,
  exchanges    INTEGER NOT NULL DEFAULT 0,
  facts        TEXT[] NOT NULL DEFAULT '{}',
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_greeted TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (npc_id, other_id)
);
CREATE INDEX IF NOT EXISTS npc_relations_por_pessoa ON streampolis.npc_relations (other_id, affinity DESC);

-- Freios por classe (SPECs §64), além do geral \`npc_enabled\`: se sessenta
-- corpos pesarem no servidor, desliga-se a classe, não a cidade.
INSERT INTO streampolis.feature_flags (key, enabled, description) VALUES
  ('npc_ambient_enabled', TRUE, 'Personagens de ambiente (figurantes com corpo de verdade).'),
  ('npc_social_enabled', TRUE, 'Personagens sociais (vontade em caixa, relações, sem LLM).')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

UPDATE streampolis.npc_agents SET kind = 'cognitive' WHERE slug = 'nilo';
`);

lines.push(`\n-- ---------------------------------------------------------------- elenco --`);
for (const r of rows) {
  lines.push(`INSERT INTO streampolis.npc_agents (id, slug, display_name, avatar, scene_id, kind, profile) VALUES (${q(r.id)}, ${q(r.slug)}, ${q(r.name)}, ${j(r.avatar)}, ${q(r.scene)}, ${q(r.kind)}, ${j(r.profile)})
  ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name, avatar = EXCLUDED.avatar, scene_id = EXCLUDED.scene_id, kind = EXCLUDED.kind, profile = EXCLUDED.profile;`);
}

lines.push(`
-- ---------------------------------------------------------------- Dalva --
-- A segunda cognitiva. Mora no Distrito Sombra; a percepção do bairro
-- (lugares, o que existe e o que não existe) está em packages/npc/src/places.ts.
INSERT INTO streampolis.npc_agents (id, slug, display_name, avatar, scene_id, kind, profile)
VALUES (${q(DALVA_ID)}, 'dalva', 'Dalva', ${j(dalvaAvatar)}, 'noir_district', 'cognitive', '{}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET avatar = EXCLUDED.avatar, scene_id = EXCLUDED.scene_id, kind = EXCLUDED.kind;

INSERT INTO streampolis.npc_persona_versions (npc_id, version, persona, source, status, activated_at)
SELECT ${q(DALVA_ID)}, 1, ${j(dalvaPersona)}, 'seed', 'active', now()
WHERE NOT EXISTS (SELECT 1 FROM streampolis.npc_persona_versions WHERE npc_id = ${q(DALVA_ID)});
`);

const out = join(HERE, '..', '..', 'api', 'migrations', '0022_npc_population.sql');
writeFileSync(out, lines.join('\n'));
const byScene = {};
for (const r of rows) byScene[r.scene] = byScene[r.scene] ?? { ambient: 0, social: 0 }, byScene[r.scene][r.kind]++;
console.log(`gerado ${out}: ${ambientN} ambiente + ${socialN} sociais + Dalva`);
console.log(JSON.stringify(byScene));

// ============================================================ AGENDA (0023) ==
//
// A rotina por horário (relógio do mundo, shared/clock.ts): quem está na
// cidade em que janela, e quem troca de cena à noite. Sai numa migration à
// parte para não tocar na 0022 já aplicada (o checksum dela é conferido).
//
// De dia: praça, comércio e circulação. À noite: a praça esvazia (9 dos 22),
// o comércio e o escritório fecham, e a circulação muda para o Distrito
// Sombra — cinco passantes da praça viram caminhantes da avenida, e o bairro
// ganha os seus próprios noturnos (esquina do bar, fila do clube, travessa).
const noirPath = (i) => NOIR.crowd[i].path.map((w) => ({ x: w.x, z: w.z, wait: w.wait }));
const noirWalk = (path, reverse = false) => {
  const pts = reverse ? [...path].reverse() : path;
  const program = pts.map((w) => ({ do: 'walk', to: { x: w.x, z: w.z }, secs: w.wait ? [w.wait, w.wait + 5] : [1, 4] }));
  for (const w of [...pts].reverse().slice(1)) program.push({ do: 'walk', to: { x: w.x, z: w.z }, secs: [1, 4] });
  return fixSteps('noir_district', program, 'turno noturno');
};
const NIGHT = [19, 6];
const SCHEDULE = {
  // Praça → Distrito Sombra à noite (circulação noturna).
  marcos: { night: { sceneId: 'noir_district', hours: NIGHT, role: 'caminhando pela avenida (noite)', program: noirWalk(noirPath(0)) } },
  renata: { night: { sceneId: 'noir_district', hours: NIGHT, role: 'caminhando pela avenida (noite)', program: noirWalk(noirPath(1), true) } },
  tiago: { night: { sceneId: 'noir_district', hours: NIGHT, role: 'caminhando pela travessa (noite)', program: noirWalk(noirPath(2)) } },
  paula: { night: { sceneId: 'noir_district', hours: NIGHT, role: 'caminhando pela avenida (noite)', program: noirWalk([{ x: 40, z: 4.4 }, { x: 16, z: 5.2, wait: 3 }, { x: -8, z: 3.8 }, { x: -30, z: 5.0, wait: 2 }]) } },
  ivo: { night: { sceneId: 'noir_district', hours: NIGHT, role: 'na esquina do bar (noite)', program: fixSteps('noir_district', [
    { do: 'stand', at: { x: -48.6, z: -5.2 }, yaw: PI - 0.6, secs: [120, 300] }, { do: 'walk', to: { x: -44, z: 4 }, secs: [10, 25] },
  ], 'ivo noite') } },
  // Praça só de dia.
  edu: { hours: [6, 23] }, cintia: { hours: [6, 23] },
  'seu-antenor': { hours: [7, 21] }, 'dona-lurdes': { hours: [7, 20] },
  henrique: { hours: [8, 20] }, simone: { hours: [8, 20] },
  'seu-nelson': { hours: [7, 23] }, joana: { hours: [6, 22] },
  // Distrito Sombra: os noturnos e o único diurno.
  nando: { hours: [18, 6] }, cida: { hours: [18, 6] },
  lipe: { hours: [19, 5] }, duda: { hours: [19, 5] },
  genivaldo: { hours: [18, 6] }, rosa: { hours: [17, 7] }, vitor: { hours: [20, 6] },
  toninho: { hours: [6, 18] },
  // Comércio e escritório: horário comercial.
  ronaldo: { hours: [8, 22] }, kesia: { hours: [8, 22] }, miguel: { hours: [8, 22] }, tania: { hours: [9, 21] },
  anderson: { hours: [8, 19] }, sofia: { hours: [8, 19] }, leandro: { hours: [8, 19] }, claudio: { hours: [8, 19] },
};
for (const slug of Object.keys(SCHEDULE)) if (!usedSlugs.has(slug)) throw new Error(`agenda para slug desconhecido: ${slug}`);

const sched = [];
sched.push(`-- 0023_npc_schedule.sql — rotina por horário (relógio do mundo, shared/clock.ts).
--
-- GERADO por packages/npc/scripts/gen-population.mjs (bloco AGENDA); não
-- edite à mão. Acrescenta ao \`profile\` dos personagens de ambiente:
--   hours  [de, até) em horas do mundo — fora da janela o corpo sai da sala;
--   night  {sceneId, program, hours} — turno noturno noutra cena.
-- Quem não aparece aqui está na cidade o dia inteiro. Nenhum mapa, bico ou
-- regra de jogo muda: só quem está onde, a que horas.`);
for (const [slug, patch] of Object.entries(SCHEDULE)) {
  sched.push(`UPDATE streampolis.npc_agents SET profile = profile || ${j(patch)} WHERE slug = ${q(slug)};`);
}
const out23 = join(HERE, '..', '..', 'api', 'migrations', '0023_npc_schedule.sql');
writeFileSync(out23, sched.join('\n') + '\n');
console.log(`gerado ${out23}: ${Object.keys(SCHEDULE).length} agendas`);

// ============================================================ CHUVA (0024) ==
//
// Abrigo da chuva: quem passeia pela praça de dia ganha um interior para onde
// ir quando a sala diz que chove (turno `rain`, ver roster.ts). Os outros da
// praça ficam — debaixo das copas, dos toldos e das marquises (coveredPoints)
// — porque é chuva, não tempestade, e uma praça vazia na chuva lê como bug.
const lobbyWalk = fixSteps('residential_lobby', [
  { do: 'walk', to: { x: 0, z: 5.5 }, secs: [20, 50] }, { do: 'walk', to: { x: -6, z: -4 }, secs: [15, 40] }, { do: 'walk', to: { x: 6, z: -4 }, secs: [15, 40] },
], 'abrigo saguão');
const storeWalk = fixSteps('stream_store', [
  { do: 'walk', to: { x: -1.6, z: -3.0 }, secs: [15, 40] }, { do: 'walk', to: { x: 1.6, z: 0.3 }, secs: [15, 40] }, { do: 'walk', to: { x: 0, z: 4.6 }, secs: [20, 50] },
], 'abrigo loja');
const RAIN_SHELTER = {
  edu: { rain: { sceneId: 'residential_lobby', role: 'abrigado da chuva no saguão', program: lobbyWalk } },
  cintia: { rain: { sceneId: 'stream_store', role: 'abrigada da chuva na loja', program: storeWalk } },
  wagner: { rain: { sceneId: 'stream_store', role: 'abrigado da chuva na loja', program: storeWalk } },
  larissa: { rain: { sceneId: 'residential_lobby', role: 'abrigada da chuva no saguão', program: lobbyWalk } },
  joana: { rain: { sceneId: 'residential_lobby', role: 'abrigada da chuva no saguão', program: lobbyWalk } },
};
for (const slug of Object.keys(RAIN_SHELTER)) if (!usedSlugs.has(slug)) throw new Error(`abrigo para slug desconhecido: ${slug}`);
const rainSql = [`-- 0024_npc_rain.sql — abrigo da chuva (clima do mundo, shared/weather.ts).
--
-- GERADO por packages/npc/scripts/gen-population.mjs (bloco CHUVA); não edite
-- à mão. Acrescenta \`rain\` {sceneId, program} ao profile de cinco figurantes
-- da praça: quando a sala publica chuva, eles trocam para um interior
-- disponível; os outros se abrigam nos pontos cobertos da própria praça
-- (copas, toldos, marquises — regra em packages/npc/src/scenes.ts).`];
for (const [slug, patch] of Object.entries(RAIN_SHELTER)) rainSql.push(`UPDATE streampolis.npc_agents SET profile = profile || ${j(patch)} WHERE slug = ${q(slug)};`);
const out24 = join(HERE, '..', '..', 'api', 'migrations', '0024_npc_rain.sql');
writeFileSync(out24, rainSql.join('\n') + '\n');
console.log(`gerado ${out24}: ${Object.keys(RAIN_SHELTER).length} abrigos`);

// ============================================================ CLUBE (0025) ==
//
// Rotinas do Clube Sombra por pontos de interesse (poi.ts): pista (dançar),
// bar (fila curta), lounge (sentar de verdade nos sofás), bordas (conversar
// de frente) e a porta. Sem LLM, sem compra: é o passo `visit` por categoria.
const CLUB_PROGRAMS = {
  kaique: [{ do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'service', poi: 'club:bar' }, { do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'social', poi: 'club:edge' }],
  rafa: [{ do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'social', poi: 'club:edge' }, { do: 'visit', kind: 'service', poi: 'club:bar' }, { do: 'visit', kind: 'landmark', poi: 'club:floor' }],
  bruno: [{ do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'service', poi: 'club:bar' }, { do: 'visit', kind: 'rest', poi: 'club:lounge' }, { do: 'visit', kind: 'landmark', poi: 'club:floor' }],
  mirela: [{ do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'rest', poi: 'club:lounge' }, { do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'transit', poi: 'club:door', secs: [3, 8] }],
  taina: [{ do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'social', poi: 'club:edge' }, { do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'service', poi: 'club:bar' }],
  livia: [{ do: 'visit', kind: 'landmark', poi: 'club:floor' }, { do: 'visit', kind: 'rest', poi: 'club:lounge' }, { do: 'visit', kind: 'service', poi: 'club:bar' }, { do: 'visit', kind: 'landmark', poi: 'club:floor' }],
  priscila: [{ do: 'visit', kind: 'social', poi: 'club:edge' }, { do: 'visit', kind: 'service', poi: 'club:bar' }, { do: 'visit', kind: 'rest', poi: 'club:lounge' }, { do: 'visit', kind: 'social', poi: 'club:edge' }],
  marcio: [{ do: 'visit', kind: 'social', poi: 'club:edge' }, { do: 'visit', kind: 'rest', poi: 'club:lounge' }, { do: 'visit', kind: 'landmark', poi: 'club:floor', secs: [40, 90] }, { do: 'visit', kind: 'service', poi: 'club:bar' }],
};
for (const slug of Object.keys(CLUB_PROGRAMS)) if (!usedSlugs.has(slug)) throw new Error(`programa de clube para slug desconhecido: ${slug}`);
const clubSql = [`-- 0025_npc_club_routines.sql — rotinas do Clube Sombra por pontos de interesse.
--
-- GERADO por packages/npc/scripts/gen-population.mjs (bloco CLUBE); não edite
-- à mão. Troca o programa de oito figurantes do clube por passos \`visit\`
-- (poi.ts): pista (dançar), bar (fila curta), lounge (sentar), bordas
-- (conversar de frente), porta. DJ e segurança ficam nos postos.`];
for (const [slug, program] of Object.entries(CLUB_PROGRAMS)) clubSql.push(`UPDATE streampolis.npc_agents SET profile = profile || ${j({ program })} WHERE slug = ${q(slug)};`);
const out25 = join(HERE, '..', '..', 'api', 'migrations', '0025_npc_club_routines.sql');
writeFileSync(out25, clubSql.join('\n') + '\n');
console.log(`gerado ${out25}: ${Object.keys(CLUB_PROGRAMS).length} rotinas do clube`);
