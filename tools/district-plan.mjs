#!/usr/bin/env node
/**
 * A planta do Distrito Sombra, conferível sem navegador.
 *
 * O mesmo argumento de `room-plan-check.mjs` para os interiores: uma planta
 * escrita à mão erra em silêncio. O tipo compila, a cena desenha, a colisão
 * responde — e uma fatia de fachada com o `x1` errado por meio metro fechou uma
 * passagem que ninguém vai testar até um bico mandar alguém por ela.
 *
 * Abrir o jogo para conferir custa um navegador headless, três minutos e uma
 * volta a pé. Isto custa duzentos milissegundos e cabe numa mensagem de commit.
 *
 * O desenho sai da MESMA colisão que o servidor usa (`resolveCollision` com o
 * raio do jogador), não de uma segunda leitura das fachadas: uma planta
 * desenhada a partir das caixas mostraria o bairro que alguém quis, e o que
 * interessa é o bairro por onde se anda.
 *
 *   node tools/district-plan.mjs [--passo=1.5]
 *
 * O quadriculado é grosso de propósito. Uma grade fina desenha frestas de meio
 * corpo como se fossem rua.
 */
import {
  NOIR, PLAYER_RADIUS, PORTALS, SCENE_AREA, SCENE_COLLIDERS, SCENE_SPAWNS, resolveCollision,
} from '../packages/game-server/dist/game-server/src/shared.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const PASSO = Number(args.passo ?? 1.5);
const area = SCENE_AREA.noir_district;
const colisores = SCENE_COLLIDERS.noir_district;

const minX = area.x - area.hw;
const minZ = area.z - area.hd;
const cols = Math.round((area.hw * 2) / PASSO);
const linhas = Math.round((area.hd * 2) / PASSO);

const livre = (x, z) => {
  const r = resolveCollision({ x, z }, colisores, area, PLAYER_RADIUS);
  return Math.hypot(r.x - x, r.z - z) < 1e-6;
};

const celula = (x, z) => `${Math.round((x - minX) / PASSO)},${Math.round((z - minZ) / PASSO)}`;

// Marcas: paradas de bico pela inicial, chegada e portal por símbolo próprio.
const marcas = new Map();
for (const [id, p] of Object.entries(NOIR.stops)) marcas.set(celula(p.x, p.z), id[0].toUpperCase());
const chegada = SCENE_SPAWNS.noir_district[0];
marcas.set(celula(chegada.x, chegada.z), '@');
for (const porta of PORTALS.noir_district) marcas.set(celula(porta.x, porta.z), '#');

let livres = 0;
const linhasTexto = [];
for (let j = 0; j < linhas; j++) {
  let linha = '';
  for (let i = 0; i < cols; i++) {
    const x = minX + (i + 0.5) * PASSO;
    const z = minZ + (j + 0.5) * PASSO;
    const aberto = livre(x, z);
    if (aberto) livres++;
    linha += marcas.get(`${i},${j}`) ?? (aberto ? '·' : '█');
  }
  linhasTexto.push(linha);
}

console.log(`\nDistrito Sombra — planta em grade de ${PASSO} m (norte para cima)\n`);
console.log(linhasTexto.join('\n'));
console.log(`\nx ∈ [${minX}, ${area.x + area.hw}]   z ∈ [${minZ}, ${area.z + area.hd}]`);
console.log(`${cols}×${linhas} células · ${livres} andáveis`
  + ` (${Math.round((livres * PASSO * PASSO))} m² de rua)`);
console.log('@ chegada   # portal   maiúscula = parada de bico   █ obstáculo\n');
