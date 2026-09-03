#!/usr/bin/env node
/**
 * ANTES × DEPOIS da normal suave na pele da cabeça v2.
 *
 * A pergunta é estreita e a resposta é uma imagem: as cabeças do pacote são
 * chapadas — cada face com a normal dela —, e é plausível que num ROSTO, que
 * tem bochecha, testa e queixo, a faceta atrapalhe. Também é plausível que ela
 * seja exatamente o estilo do jogo. Nenhuma das duas se decide de memória.
 *
 * Duas cargas da mesma página, `?smoothskin=0` e `?smoothskin=1`, com o mesmo
 * enquadramento, a mesma luz e a mesma cabeça — a mesma receita do
 * `scene-ab.mjs`, que é como o passe de assets foi decidido. Sai um par por
 * cabeça, de frente e de três quartos, e uma folha com os quatro lado a lado.
 *
 * Isto NÃO liga o experimento no jogo: o padrão continua chapado. Ligar é uma
 * decisão a tomar olhando a folha.
 *
 *   node tools/v2-skin-ab.mjs
 *   node tools/v2-skin-ab.mjs --chars=m_king,f_witch --size=560
 *   node tools/v2-skin-ab.mjs --param=skinmat --lados=pacote:0,nosso:1
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const OUT = args.out ?? 'shots/v2-skin-ab';
const SIZE = Number(args.size ?? 460);
const ZOOM = Number(args.zoom ?? 0.72);
/** Um rosto masculino e um feminino: as duas famílias de cabeça do pacote. */
const chars = (args.chars ?? 'm_casual_character,f_suit,m_business_man,f_punk').split(',');
const VIEWS = [['frente', 0], ['tres-quartos', 0.6]];
/**
 * Os três lados da comparação.
 *
 * Duas colunas não bastavam: a suavização TOTAL conserta a costura no meio da
 * cara e come o nariz junto. O ângulo-limite é a terceira via, e existe
 * justamente porque a comparação de duas mostrou que a pergunta não era
 * "suavizar ou não".
 */
const LADOS = (args.lados ?? 'chapado:0,angulo45:45,total:180').split(',')
  .map((p) => p.split(':'));
/**
 * Qual interruptor a comparação mexe.
 *
 * Nasceu para a normal (`smoothskin`) e serve para qualquer decisão de rosto
 * que tenha um interruptor — o acabamento da pele (`skinmat`) foi a segunda.
 * Duas ferramentas quase iguais é como se acaba com uma delas desatualizada.
 */
const PARAM = args.param ?? 'smoothskin';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const feito = new Map();
for (const [lado, flag] of LADOS) {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.message));
  await page.goto(`${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0`
    + `&tier=high&exp=${args.exp ?? 0.62}&${PARAM}=${flag}`,
  { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 90_000 });

  for (const char of chars) {
    const look = {
      hair: `${char}_head`, top: `${char}_top`,
      bottom: `${char}_bottom`, shoes: `${char}_shoes`,
    };
    for (const [vista, yaw] of VIEWS) {
      const res = await page.evaluate(([l, y, z]) => window.__lab.gameFace(l, y, 0, z), [look, yaw, ZOOM]);
      await writeFile(path.join(OUT, `${char}_${vista}_${lado}.png`),
        Buffer.from(res.png.split(',')[1], 'base64'));
      if (vista === 'frente') feito.set(`${char}_${lado}`, res.face?.suavizados ?? 0);
    }
  }
  if (erros.length) console.error(`! ${lado}: ${erros[0]}`);
  await page.close();
}

// A folha: uma linha por cabeça, as vistas em blocos e os lados lado a lado.
const cell = 300;
const tiles = [];
for (let r = 0; r < chars.length; r++) {
  let c = 0;
  for (const [vista] of VIEWS) {
    for (const [lado] of LADOS) {
      tiles.push({
        input: await sharp(path.join(OUT, `${chars[r]}_${vista}_${lado}.png`))
          .flatten({ background: '#151821' }).resize(cell, cell).png().toBuffer(),
        left: c * cell, top: r * cell,
      });
      c++;
    }
  }
}
await sharp({
  create: {
    width: cell * VIEWS.length * LADOS.length, height: cell * chars.length,
    channels: 3, background: '#151821',
  },
}).composite(tiles).jpeg({ quality: 92 }).toFile(path.join(OUT, 'sheet.jpg'));

console.log('vértices suavizados por cabeça (0 = chapado, o padrão):');
for (const char of chars) {
  console.log(`  ${char.padEnd(24)} ` + LADOS.map(([l]) => `${l} ${feito.get(`${char}_${l}`)}`).join('  '));
}
console.log(`\nfolha: ${path.join(OUT, 'sheet.jpg')} — colunas: `
  + VIEWS.map(([v]) => LADOS.map(([l]) => `${v}/${l}`).join(' | ')).join(' | '));
await browser.close();
