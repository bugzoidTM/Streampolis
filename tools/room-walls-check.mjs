#!/usr/bin/env node
/**
 * Prova que a sala SEGURA quem está dentro dela.
 *
 * O defeito que motivou este arquivo não aparecia em nenhuma captura de tela:
 * quem entrava no próprio apartamento nascia no lugar certo, dava UM passo e
 * aparecia do lado de fora, atravessando a parede. A causa era a conexão
 * escolher a mesa de colisão no construtor, antes do primeiro patch — quando o
 * estado da sala ainda é o default do schema, "central_plaza". O preditor
 * passava a vida inteira prevendo com a planta da praça, e o monumento dela é
 * um cilindro de 5,26 m no centro do mundo: o apartamento cabe DENTRO dele.
 *
 * Por isso a prova tem duas metades, e as duas importam:
 *   1. a cena desenhada e a cena em que se colide são a mesma;
 *   2. andar em todas as direções não põe ninguém fora da planta.
 *
 * Precisa da API (:8787), do game server (:2567) e do Vite (:5273) no ar.
 *
 *   node tools/room-walls-check.mjs
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
/** Quanto tempo se anda em cada direção. Headless, o quadro é caro. */
const HOLD_MS = Number(args.hold ?? 2200);

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const r = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ana' }),
});
if (!r.ok) { console.error('API fora do ar em', API); process.exit(2); }
const { token } = await r.json();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});

/** Fora da planta, com a folga do raio do jogador já descontada. */
function outside(area, p) {
  if (!area) return false;
  if (area.kind === 'circle') return Math.hypot(p.x - area.x, p.z - area.z) > area.r + 0.05;
  return Math.abs(p.x - area.x) > area.hw + 0.05 || Math.abs(p.z - area.z) > area.hd + 0.05;
}

const salas = [
  { nome: 'apartamento', query: `apartment=me` },
  { nome: 'saguão', query: `scene=residential_lobby` },
  { nome: 'loja', query: `scene=stream_store` },
  { nome: 'agência', query: `scene=agency_tower` },
];

for (const sala of salas) {
  console.log(`\n${sala.nome}`);
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  try {
    await page.goto(`${CLIENT}/?${sala.query}&token=${token}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
    await page.waitForTimeout(3500);

    const stats = () => page.evaluate(() => window.__lab.stats());
    const s0 = await stats();
    check('a sala é de verdade (online)', s0.online === true);
    check(
      'colide na cena que desenha',
      s0.collision?.scene === s0.scene,
      `desenha ${s0.scene}, colide ${s0.collision?.scene}`,
    );

    // Medido contra a planta da sala DESENHADA: é onde as paredes estão. Usar
    // a do preditor aqui esconderia exatamente o defeito que se quer pegar —
    // quem colide com a praça também é medido pela praça, e passa.
    const area = s0.area ?? null;
    check('a chegada é dentro da planta', !outside(area, s0.player),
      `(${s0.player.x.toFixed(2)}, ${s0.player.z.toFixed(2)})`);

    let pior = null;
    for (const key of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) {
      await page.keyboard.down(key);
      await page.waitForTimeout(HOLD_MS);
      await page.keyboard.up(key);
      await page.waitForTimeout(400);
      const p = (await stats()).player;
      if (outside(area, p)) pior = { key, p };
    }
    check('andar em toda direção não atravessa a parede', pior === null,
      pior ? `${pior.key} levou a (${pior.p.x.toFixed(2)}, ${pior.p.z.toFixed(2)})` : '');
    if (errs.length) check('sem erro de página', false, errs[0]);
  } catch (err) {
    check(`${sala.nome} abriu`, false, String(err).slice(0, 120));
  }
  await page.close();
}

await browser.close();
const falhas = results.filter((ok) => !ok).length;
console.log(`\n${results.length - falhas}/${results.length} passaram`);
process.exit(falhas > 0 ? 1 : 0);
