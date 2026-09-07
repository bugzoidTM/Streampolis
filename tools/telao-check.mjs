#!/usr/bin/env node
/**
 * Prova dos TELÕES: um em cada ambiente, e todos com o MESMO quadro.
 *
 * Duas exigências que parecem uma só e não são:
 *
 * 1. **um telão em cada ambiente.** É contagem, e é o tipo de coisa que se
 *    quebra sem barulho — um cenário novo nasce sem tela e ninguém percebe até
 *    alguém entrar nele;
 * 2. **todos sincronizados.** Aqui a prova não é comparar relógios: é
 *    IDENTIDADE. Se as quatro telas da arena apontam para o mesmo objeto de
 *    textura, elas não estão sincronizadas — elas são o mesmo quadro, e não há
 *    o que dessincronizar. Dois `<video>` tocando "juntos" passariam num teste
 *    de tempo aproximado e mesmo assim mostrariam quadros diferentes.
 *
 * Por isso o teste compara `uniforms.uVideo.value` entre os painéis da cena e
 * exige um único objeto distinto.
 *
 *   node tools/telao-check.mjs [--client=…] [--api=…]
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';

const checks = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/** Cada ambiente e a query que o abre. Nem todos entram por `?scene=`. */
const AMBIENTES = [
  { id: 'central_plaza', q: 'view=world&scene=central_plaza' },
  { id: 'noir_district', q: 'view=world&scene=noir_district' },
  { id: 'residential_lobby', q: 'view=world&scene=residential_lobby' },
  { id: 'stream_store', q: 'view=world&scene=stream_store' },
  { id: 'agency_tower', q: 'view=world&scene=agency_tower' },
  { id: 'pk_arena', q: 'view=world&scene=pk_arena' },
  { id: 'apartment', q: 'view=world&apartment=me' },
  { id: 'live_room', q: 'view=world&scene=live_room' },
];

const res = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ana' }),
});
if (!res.ok) throw new Error(`login falhou (${res.status}) — rode npm run seed`);
const { token } = await res.json();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  for (const amb of AMBIENTES) {
    const page = await browser.newPage({ viewport: { width: 700, height: 460 } });
    try {
      // `domcontentloaded`, nunca `networkidle`: vídeo em laço é conexão que
      // não fecha, e a rede nunca fica ociosa numa cena com telão.
      await page.goto(`${CLIENT}/?${amb.q}&token=${token}&name=Ana`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
      await page.waitForTimeout(2_500);

      const r = await page.evaluate(() => {
        const w = window.__world;
        const raiz = w.scene?.scene ?? w.scene;
        const texturas = [];
        const paineis = [];
        raiz.traverse((o) => {
          const m = o.material;
          if (!m?.uniforms?.uHasVideo) return;
          paineis.push({ hasVideo: m.uniforms.uHasVideo.value });
          const t = m.uniforms.uVideo.value;
          if (t && !texturas.includes(t)) texturas.push(t);
        });
        const v = texturas[0]?.image;
        return {
          cena: w.sceneId ?? null,
          paineis: paineis.length,
          texturas: texturas.length,
          tocando: paineis.filter((p) => p.hasVideo === 1).length,
          video: v ? { w: v.videoWidth, h: v.videoHeight, mudo: v.muted, laco: v.loop, t: +v.currentTime.toFixed(1) } : null,
        };
      });

      console.log(`\n${amb.id}`);
      check('tem pelo menos um telão', r.paineis >= 1, `${r.paineis} painel(is)`);
      check('todos os telões tocando', r.paineis > 0 && r.tocando === r.paineis,
        `${r.tocando}/${r.paineis}`);
      // A prova da sincronia: UMA textura para todos os painéis da cena.
      check('todos compartilham UMA textura (mesmo quadro por construção)',
        r.texturas === 1, `${r.texturas} textura(s) distinta(s)`);
      check('o vídeo é mudo e em laço', Boolean(r.video?.mudo && r.video?.laco),
        r.video ? `${r.video.w}×${r.video.h}, t=${r.video.t}s` : 'sem vídeo');
    } catch (err) {
      console.log(`\n${amb.id}`);
      check('a cena abriu', false, String(err.message).split('\n')[0]);
    } finally {
      await page.close();
    }
  }

  const falhas = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - falhas}/${checks.length} verificações passaram`);
  if (falhas > 0) process.exitCode = 1;
} finally {
  await browser.close();
}
