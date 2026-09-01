#!/usr/bin/env node
/**
 * Prova que dá para MUDAR DE VISUAL (PRD §7).
 *
 * "Criação de avatar" está na lista do MVP e o botão "Editar look" do perfil
 * abria `?view=lab` — a bancada de revisão do time, com folha de contato e
 * matriz de 176 combinações. Esta é a tela de verdade.
 *
 * A cadeia inteira tem quatro elos e cada um já falhou em algum projeto:
 * a tela muda o rascunho, a API valida e assina um token novo, o banco guarda,
 * e a SALA repinta o corpo sem ninguém reconectar. O último era o que faltava:
 * a aparência entrava na sala só no join, então quem trocava de roupa
 * continuava com a antiga para todo mundo.
 *
 *   node tools/look-check.mjs
 */
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const CLIENT = args.client ?? 'http://127.0.0.1:5273';
const API = args.api ?? 'http://127.0.0.1:8787';

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const r = await fetch(`${API}/auth/dev-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'ana' }),
});
const { token } = await r.json();

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--ignore-gpu-blocklist', '--enable-webgl', '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(`${CLIENT}/?scene=central_plaza&token=${token}&tier=low`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__ready === true, { timeout: 180_000 });
await page.waitForTimeout(800);

/** A roupa como a SALA a conhece — não como a interface a desenha. */
const inRoom = () => page.evaluate(() => {
  const w = window.__world;
  const p = w?.connection?.state?.players?.get?.(w.connection.sessionId);
  return p ? { skinTone: p.avatar.skinTone, hairColor: p.avatar.hairColor, top: p.avatar.top } : null;
});

console.log('\n1) A tela existe e abre pelo perfil');
const antes = await inRoom();
check('a sala conhece o visual atual do jogador', antes !== null, JSON.stringify(antes));

await page.getByRole('button', { name: 'Perfil' }).click({ timeout: 60_000 });
await page.getByRole('button', { name: 'Editar look' }).click({ timeout: 60_000 });
const abriu = await page.waitForSelector('.look__panel', { timeout: 30_000 }).then(() => true).catch(() => false);
check('"Editar look" abre o criador, não o laboratório', abriu);
check('o retrato do avatar aparece', await page.locator('.look__poster').count() > 0);

console.log('\n2) Experimentar não salva');
// Um tom de pele diferente do atual. Cosmético puro: não depende de posse, e é
// por isso que serve de sonda para a cadeia inteira.
const alvo = (antes.skinTone + 3) % 8;
await page.locator('.look__swatch').nth(alvo).click();
await page.waitForTimeout(400);
const durante = await inRoom();
check('mexer nos controles não muda a sala ainda', durante.skinTone === antes.skinTone);
await page.screenshot({ path: 'shots/look.png', timeout: 120_000 });

console.log('\n3) Salvar chega ao banco e à sala');
await page.getByRole('button', { name: 'Salvar' }).click();
const salvou = await page
  .waitForFunction(() => document.querySelector('.look__status')?.textContent === 'Look salvo.',
    null, { timeout: 60_000 })
  .then(() => true).catch(() => false);
check('a tela confirma que salvou', salvou);

const naSala = await page.waitForFunction((esperado) => {
  const w = window.__world;
  const p = w?.connection?.state?.players?.get?.(w.connection.sessionId);
  return p?.avatar?.skinTone === esperado;
}, alvo, { timeout: 60_000 }).then(() => true).catch(() => false);
check('a SALA repintou o avatar sem reconectar', naSala, `tom ${antes.skinTone} → ${alvo}`);

const persistido = await fetch(`${API}/me/avatar`, { headers: { authorization: `Bearer ${token}` } })
  .then((res) => res.json()).then((j) => j.avatar?.skinTone).catch(() => null);
check('o banco guardou', persistido === alvo, `${persistido}`);

console.log('\n4) O que não se possui não veste');
// As abas do criador são `role="tab"`, não `button` — pedir o papel errado
// devolve zero elementos e um teste que "passa" por não ter olhado nada.
await page.getByRole('tab', { name: 'Roupa' }).click({ timeout: 30_000 });
await page.waitForSelector('.look__chip', { timeout: 30_000 });
const trancadasRoupa = await page.locator('.look__chip.is-locked').count();
check('peças não compradas aparecem marcadas como da Loja', trancadasRoupa > 0,
  `${trancadasRoupa} trancadas`);
const antesDoClique = (await inRoom()).top;
const locked = page.locator('.look__chip.is-locked').first();
if (await locked.count()) {
  await locked.click();
  await page.waitForTimeout(400);
}
check('clicar numa peça trancada não veste', (await inRoom()).top === antesDoClique);

await browser.close();
const ok = results.filter(Boolean).length;
if (errors.length) console.log('\nerros no console:', errors.slice(0, 5));
console.log(`\n${ok === results.length ? '✅' : '❌'} ${ok}/${results.length} verificações passaram. Captura em shots/look.png`);
process.exit(ok === results.length ? 0 : 1);
