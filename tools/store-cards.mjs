#!/usr/bin/env node
/**
 * O portão do CARD DA LOJA: **toda peça do catálogo aparece no próprio quadro**.
 *
 * A loja não vende ícone: vende a peça vestida em quem está olhando, e o card é
 * o argumento de venda inteiro. Até aqui nenhuma ferramenta perguntava a ele o
 * que interessa. `screens-check.mjs` sobe o cliente inteiro, faz login e navega
 * até a Loja — ele responde "a loja abriu?", que é outra pergunta. Esta
 * responde "a peça está no quadro, e enche o quadro?".
 *
 * Duas falhas, e as duas já aconteceram:
 *
 * - **Quadro vazio.** Enquanto o enquadramento era um chute por TIPO de item,
 *   um "calçado" era uma altura fixa — e as 83 peças de vinte e um personagens
 *   não têm altura fixa nenhuma: a bota do aventureiro sobe até o joelho e a
 *   sandália mal cobre o pé. O mesmo quadro cortava uma e perdia a outra.
 * - **Peça ausente.** Id que não existe, arquivo que não chegou: o corpo nasce
 *   com as outras três peças, o card sai bonito, e o que ele mostra não é o
 *   que está à venda.
 *
 *   npm run gate:cards
 *   node tools/store-cards.mjs --limit=12          (amostra, para iterar)
 *   node tools/store-cards.mjs --url=http://...    (outro servidor de dev)
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const URL_BASE = args.url ?? 'http://127.0.0.1:5273';
const WARDROBE = 'packages/client/public/assets/wardrobe';
const OUT = args.out ?? 'shots/store-cards';

/** O card, do tamanho que a `StoreView` o pede. Mudou lá, muda aqui. */
const CARD = { hair: [220, 240], top: [220, 240], bottom: [220, 300], shoes: [220, 200] };
const SHOT = { hair: 'bust', top: 'bust', bottom: 'legs', shoes: 'feet' };

/**
 * Quanto do card a SILHUETA precisa ocupar.
 *
 * Não é uma medida de beleza: é a diferença entre um card e um quadro quase
 * vazio com uma sandália perdida no meio. Um enquadramento medido na peça
 * sempre passa folgado disto — quem reprova aqui é o quadro que errou o alvo.
 */
const MINIMO_SILHUETA = 0.25;

/**
 * A peça precisa estar em cena.
 *
 * `pieceProfile` devolve uma linha por malha daquela origem; vazio significa
 * que o corpo montou sem ela.
 */
const base = { hair: '', top: '', bottom: '', shoes: '' };

const files = (await readdir(WARDROBE))
  .filter((f) => f.endsWith('.glb') && !f.startsWith('animations') && !f.startsWith('under_'));
let pecas = files.map((f) => f.replace('.glb', ''))
  .map((id) => ({
    id,
    slot: id.endsWith('_head') ? 'hair' : id.endsWith('_top') ? 'top'
      : id.endsWith('_bottom') ? 'bottom' : id.endsWith('_shoes') ? 'shoes' : null,
  }))
  .filter((p) => p.slot)
  .sort((a, b) => a.slot.localeCompare(b.slot) || a.id.localeCompare(b.id));
if (args.limit) pecas = pecas.filter((_, i) => i % Math.ceil(pecas.length / Number(args.limit)) === 0);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 420, height: 420 } });
const erros = [];
page.on('pageerror', (e) => erros.push(e.message));
// `count=0`: o laboratório não precisa desenhar ninguém — o retrato tem
// contexto WebGL próprio, e uma cena cheia só disputa a mesma GPU de software.
await page.goto(`${URL_BASE}/?view=lab&count=0&spin=0`, { waitUntil: 'networkidle', timeout: 90000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 90000 });

await mkdir(OUT, { recursive: true });
const linhas = [];
const miniaturas = [];
const t0 = Date.now();

for (const { id, slot } of pecas) {
  const look = { ...base, [slot]: id };
  const [w, h] = CARD[slot];
  const emCena = (await page.evaluate(
    ([l, alvo]) => window.__lab.pieceProfile(l, alvo).then((r) => r.length),
    [look, id],
  )) > 0;
  const url = await page.evaluate(
    ([c, s, largura, altura, foco]) => window.__lab.poster(
      c, { shot: s, at: 1.5, width: largura, height: altura, focus: foco },
    ),
    [look, SHOT[slot], w, h, id],
  );
  const png = Buffer.from(url.split(',')[1], 'base64');
  // A silhueta é o canal ALFA: o estúdio devolve fundo transparente, então
  // "quanto do card tem alguém" é uma contagem, não uma comparação de cor.
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let dentro = 0;
  for (let i = 3; i < data.length; i += info.channels) if (data[i] > 16) dentro++;
  const silhueta = dentro / (info.width * info.height);
  const ok = emCena && silhueta >= MINIMO_SILHUETA;
  linhas.push({ id, slot, emCena, silhueta, ok });
  miniaturas.push(await sharp(png).flatten({ background: '#161a26' })
    .resize({ width: 160, height: 210, fit: 'contain', background: '#161a26' }).png().toBuffer());
  console.log(
    `${ok ? '  ' : '!!'} ${id.padEnd(42)} ${slot.padEnd(7)} ` +
    `silhueta ${(silhueta * 100).toFixed(0).padStart(3)}%${emCena ? '' : '  PEÇA FORA DE CENA'}`,
  );
}

const COLUNAS = 10;
const linhasSheet = Math.ceil(miniaturas.length / COLUNAS);
await sharp({ create: { width: 160 * COLUNAS, height: 210 * linhasSheet, channels: 3, background: '#161a26' } })
  .composite(miniaturas.map((input, i) => ({
    input, left: 160 * (i % COLUNAS), top: 210 * Math.floor(i / COLUNAS),
  })))
  .jpeg({ quality: 88 }).toFile(path.join(OUT, 'sheet.jpg'));
await writeFile(path.join(OUT, 'cards.json'), JSON.stringify({ linhas, erros }, null, 2));
await browser.close();

const ruins = linhas.filter((l) => !l.ok);
console.log(`\n${linhas.length} peças em ${((Date.now() - t0) / 1000).toFixed(0)}s — ${path.join(OUT, 'sheet.jpg')}`);
if (erros.length) console.log(`erros de console: ${erros.slice(0, 5).join(' | ')}`);
if (ruins.length) {
  console.log(`REPROVADAS (${ruins.length}): ${ruins.map((l) => l.id).join(', ')}`);
  process.exit(1);
}
console.log('todas as peças aparecem no próprio quadro.');
