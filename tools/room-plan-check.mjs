#!/usr/bin/env node
/**
 * A PLANTA de cada interior, conferida como dado.
 *
 * `room-walls-check.mjs` prova, num navegador, que a sala que se desenha é a
 * sala em que se colide. Isto aqui é a outra metade e não precisa de navegador
 * nenhum: dado o layout, o cômodo é habitável?
 *
 * As cinco perguntas, e o defeito que cada uma tranca:
 *   1. móvel dentro da parede — um caroço na parede não é chão ocupado, é
 *      armadilha (foi assim que o sofá pôde ser arrastado 80 cm para fora);
 *   2. dois móveis no mesmo chão — a cena desenha um dentro do outro;
 *   3. chegada dentro de obstáculo ou rente à porta (o mesmo do teste do
 *      servidor, repetido aqui para a planta ser conferível de uma vez só);
 *   4. ponto de chão de onde NENHUMA direção sai — o travamento;
 *   5. bolso de chão em que um corpo cabe e onde não se entra nem se sai. Um
 *      bolso pequeno é dead space e está tudo bem — mas um em que uma pessoa
 *      cabe é um canto onde alguém vai parar.
 *
 *   node tools/room-plan-check.mjs [cena]
 */
import {
  INTERIORS, SCENE_COLLIDERS, SCENE_AREA, SCENE_SPAWNS, PLAY_AREA, PORTALS,
  PLAYER_RADIUS, applyMoveIntent, penetrates, portalNear, resolveCollision,
} from '../packages/game-server/dist/shared/src/index.js';

/** Passo da varredura. 10 cm é meio corpo; mais fino não muda a resposta. */
const STEP = 0.1;
/** Bolso menor que isto é dead space, não cárcere: um corpo não cabe nele. */
const BOLSO_M2 = 0.25;
/** Folga entre uma chegada e a borda da porta (mesma do teste do servidor). */
const FOLGA = 0.35;

const alvo = process.argv[2];
const cenas = alvo ? [alvo] : Object.keys(INTERIORS);
let falhas = 0;

for (const scene of cenas) {
  const layout = INTERIORS[scene];
  if (!layout) { console.log(`✗ ${scene}: não é um interior`); falhas++; continue; }
  const { width, depth, height } = layout.shell;
  const hw = width / 2;
  const hd = depth / 2;
  const colliders = SCENE_COLLIDERS[scene];
  const area = SCENE_AREA[scene] ?? null;
  const bounds = PLAY_AREA[scene];
  const problemas = [];
  const diga = (ok, msg) => { if (!ok) problemas.push(msg); };

  // 1 e 2: a mobília cabe na sala, e cada peça no seu chão.
  const caixas = [];
  for (const f of layout.fixtures) {
    let ex;
    let ez;
    if (f.r !== undefined) { ex = f.r; ez = f.r; } else if (f.hw !== undefined && f.hd !== undefined) {
      // Meia-volta ímpar troca as meias-extensões, como em `placementFits`.
      const reto = Math.abs(Math.sin(f.ry ?? 0)) < 0.5;
      ex = reto ? f.hw : f.hd;
      ez = reto ? f.hd : f.hw;
    } else continue;
    const c = { f, x0: f.x - ex, x1: f.x + ex, z0: f.z - ez, z1: f.z + ez };
    caixas.push(c);
    // A folga é a espessura da parede: um painel de LED encostado nela fica
    // meio palmo DENTRO dela de propósito, e a parede cresce para fora. O que
    // esta regra caça é o móvel que sai do prédio — o sofá que dava para
    // arrastar 80 cm através da parede leste.
    const folga = layout.shell.wall;
    diga(c.x0 >= -hw - folga && c.x1 <= hw + folga && c.z0 >= -hd - folga && c.z1 <= hd + folga,
      `${f.kind} (${f.x}, ${f.z}) atravessa a parede — ocupa x ${c.x0.toFixed(2)}..${c.x1.toFixed(2)}, ` +
      `z ${c.z0.toFixed(2)}..${c.z1.toFixed(2)}, e a sala vai a ±${hw} × ±${hd}`);
  }
  for (let i = 0; i < caixas.length; i++) {
    for (let j = i + 1; j < caixas.length; j++) {
      const a = caixas[i];
      const b = caixas[j];
      const bate = a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.z0 < b.z1 - 1e-6 && b.z0 < a.z1 - 1e-6;
      diga(!bate, `${a.f.kind} (${a.f.x}, ${a.f.z}) e ${b.f.kind} (${b.f.x}, ${b.f.z}) ocupam o mesmo chão`);
    }
  }
  for (const f of layout.fixtures) {
    diga((f.y ?? 0) <= height + 1e-9, `${f.kind} pendurado em y=${f.y}, acima do teto (${height})`);
  }

  // 3: as chegadas.
  for (const s of SCENE_SPAWNS[scene] ?? []) {
    const livre = resolveCollision(s, colliders, area, PLAYER_RADIUS);
    diga(Math.hypot(livre.x - s.x, livre.z - s.z) < 1e-6, `a chegada (${s.x}, ${s.z}) está dentro de um móvel`);
    const porta = portalNear(scene, s.x, s.z);
    diga(!porta, `a chegada (${s.x}, ${s.z}) cai dentro de "${porta?.label}"`);
    for (const p of PORTALS[scene] ?? []) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      diga(d >= p.r + FOLGA, `a chegada (${s.x}, ${s.z}) fica a ${d.toFixed(2)} m de "${p.label}" (mínimo ${(p.r + FOLGA).toFixed(2)})`);
    }
  }

  // 4 e 5: varrer o chão.
  const anda = (x0, z0, ang, ticks = 16) => {
    let p = { x: x0, z: z0, yaw: 0, moving: false };
    for (let i = 0; i < ticks; i++) {
      const n = applyMoveIntent(p, { dx: Math.cos(ang), dz: Math.sin(ang), yaw: 0, run: false, seq: i + 1 }, bounds);
      const s = resolveCollision(n, colliders, area, PLAYER_RADIUS, p);
      p = { x: s.x, z: s.z, yaw: n.yaw, moving: n.moving };
    }
    return Math.hypot(p.x - x0, p.z - z0);
  };

  const chao = [];
  let travados = 0;
  for (let x = -hw; x <= hw; x += STEP) {
    for (let z = -hd; z <= hd; z += STEP) {
      const p = { x, z };
      if (penetrates(p, colliders)) continue;
      chao.push(p);
      let melhor = 0;
      for (let d = 0; d < 16 && melhor < 0.5; d++) melhor = Math.max(melhor, anda(x, z, (d / 16) * Math.PI * 2));
      if (melhor < 0.05) {
        travados++;
        if (travados <= 3) problemas.push(`chão travado em (${x.toFixed(2)}, ${z.toFixed(2)}): nenhuma das 16 direções anda`);
      }
    }
  }
  diga(travados === 0, `${travados} pontos de chão travados`);

  // Ilhas: pedaços de chão que não se ligam ao resto.
  const chave = (p) => `${Math.round(p.x / STEP)}:${Math.round(p.z / STEP)}`;
  const todas = new Set(chao.map(chave));
  const visto = new Set();
  const ilhas = [];
  for (const inicio of chao) {
    if (visto.has(chave(inicio))) continue;
    const fila = [inicio];
    const ilha = [];
    visto.add(chave(inicio));
    while (fila.length) {
      const p = fila.pop();
      ilha.push(p);
      for (const [dx, dz] of [[STEP, 0], [-STEP, 0], [0, STEP], [0, -STEP]]) {
        const n = { x: p.x + dx, z: p.z + dz };
        const k = chave(n);
        if (!todas.has(k) || visto.has(k)) continue;
        visto.add(k);
        fila.push(n);
      }
    }
    ilhas.push(ilha);
  }
  ilhas.sort((a, b) => b.length - a.length);
  for (const ilha of ilhas.slice(1)) {
    const m2 = ilha.length * STEP * STEP;
    const p = ilha[0];
    diga(m2 < BOLSO_M2,
      `bolso de ${m2.toFixed(2)} m² isolado do resto do chão, em (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) — ` +
      'cabe uma pessoa, e de lá não se sai');
  }

  const livre = (ilhas[0]?.length ?? 0) * STEP * STEP;
  const ok = problemas.length === 0;
  if (!ok) falhas++;
  console.log(`${ok ? '✓' : '✗'} ${scene}: ${width} × ${depth} m (${(width * depth).toFixed(0)} m²), ` +
    `${layout.fixtures.length} peças, ${livre.toFixed(0)} m² de chão livre` +
    (ilhas.length > 1 ? `, ${ilhas.length - 1} bolso(s)` : ''));
  for (const p of problemas) console.log(`    ✗ ${p}`);
}

process.exit(falhas ? 1 : 0);
