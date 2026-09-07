#!/usr/bin/env node
/**
 * Fotografa o TELÃO da praça (PRD §6), enquadrado.
 *
 * Existe porque enquadrar o telão à mão é surpreendentemente difícil, e eu
 * perdi duas rodadas descobrindo isso: a câmera é uma órbita de terceira pessoa
 * e o avatar fica no CENTRO do quadro — exatamente em cima do terço do meio do
 * painel, que é onde o vídeo mora. Apontar para o telão é apontar para as
 * costas do próprio personagem.
 *
 * Os dois truques que resolvem, e que não são óbvios:
 *
 * 1. **mirar AO LADO do telão** (`--alvo=-11`), não nele. O painel sai de trás
 *    do avatar e aparece inteiro, com o vídeo à mostra;
 * 2. **escrever `yaw`/`pitch` direto no `CameraManager`**, em vez de arrastar o
 *    mouse. São campos públicos; arrastar exige acertar a sensibilidade em
 *    pixels e converge devagar, quando converge.
 *
 * Sem isto, conferir uma mudança no telão é abrir o jogo e andar até lá — e a
 * primeira coisa que se descobre andando é que o vídeo estava de cabeça para
 * baixo há um commit inteiro sem ninguém ver.
 *
 *   node tools/telao-shot.mjs [--out=shots/telao.png] [--alvo=-11]
 *   node tools/telao-shot.mjs --scene=noir_district --tx=14 --tz=9 --alvo=-4 --alt=9
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';
const OUT = args.out ?? 'shots/telao.png';
const SCENE = args.scene ?? 'central_plaza';
/** Onde o telão está, e a que altura fica o centro dele. */
const TX = Number(args.tx ?? 0);
const TZ = Number(args.tz ?? -34);
const ALT = Number(args.alt ?? 8.6);
/** X para onde a câmera olha. Mirar AO LADO do painel o tira de trás do avatar. */
const ALVO_X = Number(args.alvo ?? -11);

const res = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: args.user ?? 'ana' }),
});
if (!res.ok) throw new Error(`login falhou (${res.status}) — rode npm run seed`);
const { token } = await res.json();

await mkdir(path.dirname(OUT), { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
try {
  // `domcontentloaded`, nunca `networkidle`: o telão toca vídeo em laço, e uma
  // conexão de mídia que não fecha nunca deixa a rede ficar ociosa.
  await page.goto(`${CLIENT}/?view=world&scene=${SCENE}&token=${token}&name=Ana`,
    { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60_000 });
  await page.waitForTimeout(3_500);

  const estado = await page.evaluate(({ alvoX, tz, alt }) => {
    const w = window.__world;
    const c = w.connection.predictor.current;
    const cam = w.camera;
    const dx = alvoX - c.x;
    const dz = tz - c.z;
    const d = Math.hypot(dx, dz);
    cam.yaw = Math.atan2(-dx, -dz);
    // `pitch` positivo olha para BAIXO, daí o sinal.
    cam.pitch = -Math.atan2(alt - 1.2, d);
    cam.distance = 2.4;
    if ('smoothDistance' in cam) cam.smoothDistance = 2.4;

    // De quebra, o estado do vídeo — é o que prova que o painel está tocando,
    // e não apenas que ele existe.
    let video = null;
    const raiz = w.scene?.scene ?? w.scene;
    raiz.traverse((o) => {
      const m = o.material;
      if (!m?.uniforms?.uHasVideo) return;
      const v = m.uniforms.uVideo.value?.image;
      video = {
        hasVideo: m.uniforms.uHasVideo.value,
        rect: m.uniforms.uRect.value.toArray().map((n) => +n.toFixed(3)),
        ...(v ? { w: v.videoWidth, h: v.videoHeight, paused: v.paused, mudo: v.muted, laco: v.loop } : {}),
      };
    });
    return { video };
  }, { alvoX: ALVO_X, tz: TZ, alt: ALT });

  await page.waitForTimeout(2_500);
  await page.screenshot({ path: OUT });
  console.log(`${OUT}\n${JSON.stringify(estado.video)}`);
} finally {
  await browser.close();
}
