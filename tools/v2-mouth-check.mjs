#!/usr/bin/env node
/**
 * A boca do corpo v2, conferida onde uma captura não responde.
 *
 * `v2-face.mjs` fotografa o rosto e pergunta se ele lê como rosto. Esta prova é
 * a outra metade, e é numérica, porque os três jeitos de a boca estar errada
 * dão a MESMA imagem — um rosto sem boca:
 *
 *   1. ela não foi criada (a cabeça não tem olho de onde tirar as medidas —
 *      correto no astronauta e no tático, defeito em qualquer outra);
 *   2. ela foi criada ATRÁS da pele, e o rosto a engoliu. Foi assim que a
 *      primeira versão saiu: o meio da boca entrava na cara e só as pontas
 *      apareciam, porque a pele abaixo do nariz está a dois centésimos de
 *      milímetro do plano em que o olho do pacote fica;
 *   3. ela não está presa ao osso da cabeça, e some do rosto no primeiro gesto.
 *
 * Para cada personagem: onde ficou a boca, onde está a PELE naquela altura
 * (medida por raio, porque nesta malha o meio do rosto não tem vértice), e a
 * distância entre a boca e o osso `Head` em três animações — que, se a boca é
 * do osso, é a mesma nas três.
 *
 *   node tools/v2-mouth-check.mjs
 *   node tools/v2-mouth-check.mjs --chars=m_king,f_witch
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

/** Um de cada família de cabeça, mais os dois sem rosto e dois com barba. */
const chars = (args.chars ?? [
  'm_casual_character', 'm_business_man', 'm_farmer', 'm_king', 'm_worker',
  'f_suit', 'f_punk', 'f_witch', 'f_adventurer',
  'm_astronaut', 'm_swat',
].join(',')).split(',').filter(Boolean);

/** Cabeça que é capacete não tem rosto — e não pode ganhar boca. */
const SEM_ROSTO = new Set(['m_astronaut', 'm_swat']);

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0&tier=low`,
  { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });

let falhas = 0;
const diga = (ok, msg) => { if (!ok) falhas++; console.log(`  ${ok ? '✓' : '✗'} ${msg}`); };

for (const char of chars) {
  const look = {
    hair: `${char}_head`, top: `${char}_top`,
    bottom: `${char}_bottom`, shoes: `${char}_shoes`,
  };
  const res = await page.evaluate(([l]) => window.__lab.headProfile(l), [look]);
  if (!res) { console.error('sem __lab.headProfile — a bancada é antiga'); process.exit(2); }
  const boca = res.face?.boca ?? null;
  console.log(`\n${char}`);

  if (SEM_ROSTO.has(char)) {
    diga(boca === null, 'capacete não ganha boca');
    continue;
  }

  if (!boca) { diga(false, 'a boca não foi criada'); continue; }
  const [, alturaBoca, frenteBoca] = boca.centro;
  const [, , fundo] = boca.tamanho;
  const frente = frenteBoca + fundo / 2;

  // A pele na altura da boca, por coluna. O traço tem de estar À FRENTE dela
  // em toda a sua largura — inclusive nos cantos, que é onde a bochecha recua.
  const larguraMeia = boca.tamanho[0] / 2;
  // Só PELE: na cabeça barbada o raio bate na barba, que fica na frente do
  // rosto de propósito — e uma boca por cima da barba do rei seria pior que uma
  // boca escondida atrás dela.
  const naAltura = res.superficie.filter(([x, y]) => Math.abs(y - alturaBoca) < 0.00006
    && Math.abs(x) <= larguraMeia + 0.00004);
  const perto = naAltura.filter((h) => h[3] === 1);
  const pelo = naAltura.filter((h) => h[3] === 0 && h[2] > frente);
  if (pelo.length) {
    console.log(`  · barba na frente da boca em ${pelo.length} de ${naAltura.length} pontos — ela fica escondida, e é o certo`);
  }
  // Faixa sem PELE nenhuma é o operário: o bigode dele ocupa a largura inteira
  // na altura da boca, e o traço sai logo abaixo dele (é o que a captura
  // mostra). Não há pele com que comparar, e não há defeito — o defeito seria
  // não haver NADA ali, que é raio nenhum ter achado rosto.
  const coberta = perto.length === 0 && naAltura.length > 0;
  if (coberta) console.log('  ✓ a faixa da boca é toda barba — o traço sai por baixo dela');
  else diga(perto.length > 0, `a pele foi medida na altura da boca — ${perto.length} pontos`);
  if (!coberta && naAltura.length === 0) diga(false, 'o raio não achou rosto na altura da boca');
  if (perto.length) {
    const pele = Math.max(...perto.map((p) => p[2]));
    diga(frente > pele,
      `a boca está À FRENTE da pele — traço em ${frente.toFixed(6)}, pele em ${pele.toFixed(6)}`);
    // Sobrar demais é tão defeito quanto afundar: a boca vira um degrau colado
    // no rosto. Meio vão entre os olhos seria um centímetro e meio.
    const folga = frente - pele;
    diga(folga < 0.00012, `e encostada nela — folga de ${(folga * 1000).toFixed(3)} milésimos`);
  }

  // Entre o nariz e o queixo: a boca não pode nascer no meio do nariz.
  const meio = res.superficie.filter(([x]) => Math.abs(x) < 7e-5);
  const nariz = meio.reduce((a, b) => (b[2] > a[2] ? b : a), meio[0]);
  diga(alturaBoca < nariz[1],
    `abaixo do nariz — boca em ${alturaBoca.toFixed(5)}, ponta do nariz em ${nariz[1].toFixed(5)}`);

  // E presa ao osso: a distância não muda de gesto para gesto.
  const dists = Object.values(res.presa);
  const spread = Math.max(...dists) - Math.min(...dists);
  diga(dists.length >= 2 && spread < 1e-4,
    `presa ao osso Head — ${Object.entries(res.presa).map(([k, v]) => `${k} ${v.toFixed(4)}`).join(', ')}`);
}

if (errors.length) console.error(`\n! erros de página: ${errors[0]}`);
console.log(falhas ? `\n❌ ${falhas} verificação(ões) falharam.` : '\n✅ a boca está no rosto de todo mundo que tem rosto.');
await browser.close();
process.exit(falhas ? 1 : 0);
