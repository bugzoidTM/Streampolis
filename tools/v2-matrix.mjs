#!/usr/bin/env node
/**
 * O portão do guarda-roupa v2: **nenhuma combinação da loja pode ter buraco**.
 *
 * O corpo procedural tem `gate:avatar`, que mede 176 combinações por raio
 * contra a superfície real e barra roupa nova enquanto estiver vermelho. As 83
 * peças do pacote entraram na loja SEM portão nenhum, e a falha que elas podem
 * ter é outra: no v1 existe um corpo por baixo e a roupa é ele inflado, então o
 * pior caso é pele à mostra; aqui não existe corpo nenhum — as quatro peças SÃO
 * o personagem, o `top` traz o pano e os braços, o `bottom` traz as pernas — e
 * duas peças que não se encontram deixam ver o cenário atrás. Um avatar partido
 * na cintura.
 *
 * A varredura cobre **toda peça do catálogo pelo menos uma vez** e força
 * combinações que ninguém montaria por acaso: os dois rigs cruzados (uma blusa
 * masculina numa cabeça feminina é reamarrada a um esqueleto de outra pose de
 * bind), o mais curto com o mais baixo, a bota com o vestido.
 *
 *   npm run gate:wardrobe
 *   node tools/v2-matrix.mjs --shots     (contact sheet junto, mais lento)
 */
import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const out = args.out ?? 'shots/v2-matrix';
const WARDROBE = 'packages/client/public/assets/wardrobe';
/** Um buraco menor do que isto é costura, não rasgo. */
const TOLERANCIA_MM = Number(args.tol ?? 12);

// O FORRO não é peça de loja: ninguém compra o próprio corpo, e o avatar o
// veste sozinho quando o visual mistura personagens. Medi-lo como se fosse uma
// calça produz combinações que o jogo nunca monta.
const files = (await readdir(WARDROBE))
  .filter((f) => f.endsWith('.glb') && !f.startsWith('animations') && !f.startsWith('under_'));
const bySlot = { head: [], top: [], bottom: [], shoes: [] };
for (const f of files) {
  const id = f.replace('.glb', '');
  const slot = id.endsWith('_head') ? 'head' : id.endsWith('_top') ? 'top'
    : id.endsWith('_bottom') ? 'bottom' : id.endsWith('_shoes') ? 'shoes' : null;
  if (slot) bySlot[slot].push(id);
}
for (const slot of Object.keys(bySlot)) bySlot[slot].sort();

/**
 * As combinações a medir.
 *
 * Primeiro os 21 personagens inteiros, que é a linha de base: se um conjunto
 * que o autor do pacote desenhou já tem buraco, o defeito não é da mistura.
 * Depois um rodízio defasado, que garante TODA peça pelo menos uma vez e
 * troca o rig de propósito — o índice de cada slot anda em passos diferentes,
 * então cabeça feminina cai com blusa masculina e vice-versa.
 */
function combos() {
  const list = [];
  const chars = [...new Set(bySlot.head.map((id) => id.replace(/_head$/, '')))];
  for (const c of chars) {
    const look = {
      hair: `${c}_head`, top: `${c}_top`, bottom: `${c}_bottom`, shoes: `${c}_shoes`,
    };
    if (bySlot.top.includes(look.top) && bySlot.bottom.includes(look.bottom)
      && bySlot.shoes.includes(look.shoes)) list.push({ nome: `inteiro:${c}`, look });
  }
  const n = Math.max(bySlot.head.length, bySlot.top.length, bySlot.bottom.length, bySlot.shoes.length);
  const passos = [1, 5, 9, 13];
  for (let i = 0; i < n * Number(args.voltas ?? 4); i++) {
    const look = {
      hair: bySlot.head[(i * passos[0]) % bySlot.head.length],
      top: bySlot.top[(i * passos[1] + 3) % bySlot.top.length],
      bottom: bySlot.bottom[(i * passos[2] + 7) % bySlot.bottom.length],
      shoes: bySlot.shoes[(i * passos[3] + 11) % bySlot.shoes.length],
    };
    list.push({ nome: `mistura:${i}`, look });
  }
  return list;
}

const lista = combos();
const cobertas = new Set(lista.flatMap((c) => Object.values(c.look)));
const total = files.length;
console.log(`${lista.length} combinações, ${cobertas.size} de ${total} peças cobertas`);
if (cobertas.size < total) {
  console.error(`✗ ${total - cobertas.size} peças nunca vestidas: ${files.map((f) => f.replace('.glb', '')).filter((id) => !cobertas.has(id)).slice(0, 8).join(', ')}`);
}

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 380, height: 560 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`${args.url ?? 'http://127.0.0.1:5273/'}?view=lab&count=0&spin=0&yaw=0&tier=high`,
  { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const relatorio = [];
let reprovadas = 0;
for (const { nome, look } of lista) {
  const r = await page.evaluate(([l]) => window.__lab.wardrobeProbe(l), [look]);
  if (!r) { console.error('sem __lab.wardrobeProbe — a bancada é antiga'); process.exit(2); }
  const pior = r.buracos[0];
  const ok = !pior || pior.mm < TOLERANCIA_MM;
  if (!ok) {
    reprovadas++;
    console.log(`  ✗ ${nome} — buraco de ${pior.mm} mm entre ${pior.de} m e ${pior.ate} m`);
    console.log(`     ${look.hair} | ${look.top} | ${look.bottom} | ${look.shoes}`);
    if (args.shots) {
      const shot = await page.evaluate(([l]) => window.__lab.gameFigure(l, 0, 'idle', 1), [look]);
      await writeFile(path.join(out, `${nome.replace(/:/g, '_')}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
    }
  }
  relatorio.push({ nome, look, ...r, ok });
}

await writeFile(path.join(out, 'report.json'), JSON.stringify({
  tolerancia_mm: TOLERANCIA_MM, combinacoes: lista.length, reprovadas, relatorio, errors,
}, null, 2));

if (errors.length) console.error(errors.slice(0, 5).join('\n'));
await browser.close();

if (reprovadas || cobertas.size < total) {
  console.error(`\n✗ ${reprovadas} de ${lista.length} combinações com buraco. ${out}/report.json`);
  process.exit(1);
}
console.log(`\n✅ ${lista.length}/${lista.length} combinações inteiras, sem buraco acima de ${TOLERANCIA_MM} mm`);
