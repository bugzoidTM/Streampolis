#!/usr/bin/env node
/**
 * A boca do corpo v2, no elenco INTEIRO — de olho e de régua.
 *
 * O elenco sai do catálogo, e não de uma lista escrita aqui: são 21 cabeças, e
 * uma lista à mão envelhece calada no dia em que entrar a vigésima segunda.
 * Duas delas são capacete (astronauta, tático) e não podem ganhar boca; as
 * outras dezenove precisam de uma, no lugar certo.
 *
 * ## Por que a prova tem duas metades
 *
 * A captura responde "isto lê como boca?" e não responde mais nada: os três
 * jeitos de a boca estar errada dão a MESMA imagem, um rosto sem boca —
 *
 *   1. ela não foi criada (a cabeça não tem olho de onde tirar as medidas);
 *   2. ela foi criada ATRÁS da pele, e o rosto a engoliu. Foi assim que a
 *      primeira versão saiu: o meio entrava na cara e só as pontas apareciam,
 *      porque a pele abaixo do nariz está a 0,00002 do plano em que o olho do
 *      pacote fica — dois milímetros no mundo;
 *   3. ela não está presa ao osso da cabeça, e some no primeiro gesto.
 *
 * Então a régua mede: onde ficou a boca, onde está a PELE naquela altura
 * (por RAIO, porque nesta malha o meio do rosto não tem vértice), e a distância
 * entre a boca e o osso `Head` em três animações — que, se ela é do osso, é a
 * mesma nas três.
 *
 * E a captura é de FRENTE e de TRÊS QUARTOS, porque metade dos defeitos de uma
 * peça de rosto só aparece de lado: de frente, uma boca meio centímetro à
 * frente da cara ainda é uma boca; de três quartos, é um degrau.
 *
 *   node tools/v2-mouth-check.mjs
 *   node tools/v2-mouth-check.mjs --heads=m_king_head,f_witch_head --shot=false
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ITEM_CATALOG } from '../packages/game-server/dist/shared/src/index.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const OUT = args.out ?? 'shots/v2-mouth';
const SIZE = Number(args.size ?? 300);
/** De frente e de três quartos. O perfil não entra: metade do rosto some nele. */
const VIEWS = [['frente', 0], ['tres-quartos', 0.62]];

/** Cabeça que é capacete não tem rosto — e não pode ganhar boca. */
const SEM_ROSTO = new Set(['m_astronaut_head', 'm_swat_head']);

const heads = (args.heads
  ? args.heads.split(',')
  : ITEM_CATALOG.filter((i) => i.type === 'hair' && /_head$/.test(i.id)).map((i) => i.id)
).filter(Boolean);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0`
  + `&tier=${args.tier ?? 'high'}&exp=${args.exp ?? 0.62}`, { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 });

const comFoto = args.shot !== 'false';
if (comFoto) {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
}

let falhas = 0;
const linhas = [];
const t0 = Date.now();

for (const head of heads) {
  const char = head.replace(/_head$/, '');
  // Só a CABEÇA varia. As outras três peças são as do próprio personagem, e o
  // avatar cai no traje padrão quando alguma não existe — o que se prova aqui é
  // o rosto, não o guarda-roupa.
  const look = { hair: head, top: `${char}_top`, bottom: `${char}_bottom`, shoes: `${char}_shoes` };
  const problemas = [];
  const diga = (ok, msg) => { if (!ok) problemas.push(msg); };

  const res = await page.evaluate(([l]) => window.__lab.headProfile(l), [look]);
  if (!res) { console.error('sem __lab.headProfile — a bancada é antiga'); process.exit(2); }
  const boca = res.face?.boca ?? null;
  const rosto = !SEM_ROSTO.has(head);
  let barba = 0;
  let folga = null;

  if (!rosto) {
    diga(boca === null, 'capacete ganhou boca — não há rosto onde pô-la');
  } else if (!boca) {
    diga(false, 'sem boca: o rosto não foi encontrado nesta cabeça');
  } else {
    const [, alturaBoca, frenteBoca] = boca.centro;
    const frente = frenteBoca + boca.tamanho[2] / 2;
    const larguraMeia = boca.tamanho[0] / 2;

    // A superfície na altura da boca, separada em PELE e PELO: numa cabeça
    // barbada o raio bate na barba, que fica na frente do rosto de propósito —
    // e uma boca por cima da barba do rei seria pior que uma escondida atrás.
    const naAltura = res.superficie.filter(([x, y]) => Math.abs(y - alturaBoca) < 0.00006
      && Math.abs(x) <= larguraMeia + 0.00004);
    const pele = naAltura.filter((h) => h[3] === 1);
    const pelo = naAltura.filter((h) => h[3] === 0 && h[2] > frente);
    barba = pelo.length;
    diga(naAltura.length > 0, 'nenhum raio achou rosto na altura da boca');

    if (pele.length) {
      const z = Math.max(...pele.map((p) => p[2]));
      folga = +((frente - z) * 1000).toFixed(2);
      diga(frente > z, `a boca está ATRÁS da pele — traço em ${frente.toFixed(6)}, pele em ${z.toFixed(6)}`);
      // Sobrar demais é tão defeito quanto afundar: vira um degrau colado no
      // rosto, e é de três quartos que isso aparece.
      diga(frente - z < 0.00012, `a boca sobra ${folga} milésimos da pele — degrau`);
    }

    // Abaixo do nariz: a primeira versão nascia na base dele, e o nariz tapava
    // o meio da boca.
    const meio = res.superficie.filter(([x]) => Math.abs(x) < 7e-5);
    if (meio.length) {
      const nariz = meio.reduce((a, b) => (b[2] > a[2] ? b : a), meio[0]);
      diga(alturaBoca < nariz[1],
        `a boca está na altura do nariz — boca em ${alturaBoca.toFixed(5)}, ponta em ${nariz[1].toFixed(5)}`);
    }

    // E presa ao osso: a distância não muda de gesto para gesto.
    const dists = Object.values(res.presa ?? {});
    const spread = dists.length ? Math.max(...dists) - Math.min(...dists) : 1;
    diga(dists.length >= 2 && spread < 1e-4,
      `a boca não é do osso Head — a distância varia ${spread.toFixed(6)} entre gestos`);
  }

  if (comFoto) {
    for (const [nome, yaw] of VIEWS) {
      const shot = await page.evaluate(([l, y]) => window.__lab.gameFace(l, y, 0, 0.86), [look, yaw]);
      await writeFile(path.join(OUT, `${head}_${nome}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
    }
  }

  falhas += problemas.length;
  linhas.push({
    cabeça: head,
    boca: boca ? boca.centro[1].toFixed(5) : (rosto ? 'NENHUMA' : '— capacete'),
    'folga (milésimos)': folga,
    barba,
    ok: problemas.length === 0,
  });
  console.log(`${problemas.length ? '✗' : '✓'} ${head}`);
  for (const p of problemas) console.log(`    ✗ ${p}`);
}

// ---------------------------------------------------------------------------
// As quatro EXPRESSÕES, numa cabeça de cada família.
//
// A caixa envolvente sozinha não separa um sorriso de uma tristeza: as duas
// curvam a mesma linha para lados opostos e ocupam a mesma caixa. Quem separa é
// a altura dos CANTOS contra a do meio, que a boca publica.
// ---------------------------------------------------------------------------
const ESTADOS = ['neutral', 'smile', 'surprise', 'sad'];
const expressivas = args.heads ? [] : ['m_casual_character_head', 'f_suit_head'];
const tirasExp = [];
for (let r = 0; r < expressivas.length; r++) {
  const head = expressivas[r];
  const char = head.replace(/_head$/, '');
  const look = { hair: head, top: `${char}_top`, bottom: `${char}_bottom`, shoes: `${char}_shoes` };
  const medidas = {};
  for (let c = 0; c < ESTADOS.length; c++) {
    const st = ESTADOS[c];
    const shot = await page.evaluate(([l, s]) => window.__lab.gameFace(l, 0, 0, 0.8, s), [look, st]);
    medidas[st] = shot.face?.boca ?? null;
    if (comFoto) {
      const buf = Buffer.from(shot.png.split(',')[1], 'base64');
      await writeFile(path.join(OUT, `expressao_${char}_${st}.png`), buf);
      tirasExp.push({
        input: await sharp(buf).flatten({ background: '#151821' }).resize(220, 220).png().toBuffer(),
        left: c * 220, top: r * 220,
      });
    }
  }
  const alt = (st) => medidas[st]?.tamanho[1] ?? 0;
  const cantos = (st) => medidas[st]?.cantos ?? 0;
  const problemas = [];
  const diga = (ok, msg) => { if (!ok) problemas.push(msg); };
  diga(ESTADOS.every((st) => medidas[st]?.estado === st), 'a boca não adotou o estado pedido');
  diga(alt('surprise') > alt('neutral') * 2,
    `a surpresa mal abre — ${alt('surprise').toFixed(5)} contra ${alt('neutral').toFixed(5)} da neutra`);
  diga(cantos('smile') > cantos('neutral'),
    `o sorriso não levanta os cantos — ${cantos('smile')} contra ${cantos('neutral')}`);
  diga(cantos('sad') < 0,
    `a tristeza não derruba os cantos — ${cantos('sad')}`);
  // E voltar é voltar: um estado que deixa resíduo vira expressão permanente.
  const volta = await page.evaluate(([l]) => window.__lab.gameFace(l, 0, 0, 0.8, 'neutral'), [look]);
  diga(JSON.stringify(volta.face?.boca?.tamanho) === JSON.stringify(medidas.neutral?.tamanho),
    'voltar para neutra não devolve a boca ao mesmo lugar');
  falhas += problemas.length;
  console.log(`${problemas.length ? '✗' : '✓'} ${char}: quatro expressões ` +
    `(cantos ${ESTADOS.map((st) => `${st[0]}=${cantos(st)}`).join(' ')})`);
  for (const p of problemas) console.log(`    ✗ ${p}`);
}
if (comFoto && tirasExp.length) {
  await sharp({
    create: {
      width: 220 * ESTADOS.length, height: 220 * expressivas.length,
      channels: 3, background: '#151821',
    },
  }).composite(tirasExp).jpeg({ quality: 92 }).toFile(path.join(OUT, 'expressoes.jpg'));
  console.log(`expressões: ${path.join(OUT, 'expressoes.jpg')}`);
}

// A folha de contato: duas cabeças por linha, frente e três quartos de cada.
if (comFoto) {
  const cell = 220;
  const tiles = [];
  for (let i = 0; i < heads.length; i++) {
    for (let v = 0; v < VIEWS.length; v++) {
      const file = path.join(OUT, `${heads[i]}_${VIEWS[v][0]}.png`);
      tiles.push({
        input: await sharp(file).flatten({ background: '#151821' }).resize(cell, cell).png().toBuffer(),
        left: ((i % 2) * VIEWS.length + v) * cell,
        top: Math.floor(i / 2) * cell,
      });
    }
  }
  await sharp({
    create: {
      width: cell * VIEWS.length * 2, height: cell * Math.ceil(heads.length / 2),
      channels: 3, background: '#151821',
    },
  }).composite(tiles).jpeg({ quality: 90 }).toFile(path.join(OUT, 'sheet.jpg'));
  console.log(`\nfolha de contato: ${path.join(OUT, 'sheet.jpg')}`);
}

if (errors.length) console.error(`\n! erro de página: ${errors[0]}`);
console.table(linhas);
console.log(falhas
  ? `\n❌ ${falhas} problema(s) em ${heads.length} cabeças (${((Date.now() - t0) / 1000).toFixed(0)}s).`
  : `\n✅ ${heads.length} cabeças em ${((Date.now() - t0) / 1000).toFixed(0)}s: boca no rosto de quem tem rosto, e em nenhum capacete.`);
await browser.close();
process.exit(falhas ? 1 : 0);
