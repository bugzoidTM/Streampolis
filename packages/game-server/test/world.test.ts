import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PORTALS, SCENE_SPAWNS, SCENE_COLLIDERS, SCENE_AREA, PLAYER_RADIUS,
  GIGS, GIG_STOP_RADIUS, HEAT_MAX, HEAT_STEPS, NOIR,
  heatLevel, heatPayout, heatSeconds,
  portalNear, resolveCollision, type SceneId,
} from '../src/shared.js';

/**
 * As regras do MUNDO como dado: onde se chega e onde estão as portas.
 *
 * Isto não testa código, testa a planta — e é de propósito. Portas e pontos de
 * chegada são tabelas que duas autoridades leem (o servidor sorteia a chegada,
 * o cliente desenha a porta e mede a distância), e o defeito que elas produzem
 * não aparece em nenhum tipo: o jogo compila, a sala abre, e o jogador nasce
 * dentro da porta de saída.
 */

/**
 * Folga entre o ponto de chegada e a zona de uma porta.
 *
 * Não basta ficar de fora por um centímetro: a posição que o jogador vê é a do
 * PREDITOR do cliente, e ela oscila em torno da do servidor. Chegar rente à
 * borda faz o convite de sair piscar sozinho.
 */
const FOLGA = 0.35;

const scenes = Object.keys(PORTALS) as SceneId[];

describe('planta do mundo', () => {
  it('ninguém nasce dentro de uma porta', () => {
    for (const scene of scenes) {
      for (const spawn of SCENE_SPAWNS[scene] ?? []) {
        const dentro = portalNear(scene, spawn.x, spawn.z);
        assert.equal(
          dentro, null,
          `${scene}: a chegada (${spawn.x}, ${spawn.z}) cai dentro de "${dentro?.label}" — ` +
          'quem entra aparece com o convite de SAIR na tela, e um E o manda de volta',
        );
      }
    }
  });

  it('nem rente à borda dela', () => {
    for (const scene of scenes) {
      for (const spawn of SCENE_SPAWNS[scene] ?? []) {
        for (const portal of PORTALS[scene] ?? []) {
          const d = Math.hypot(spawn.x - portal.x, spawn.z - portal.z);
          assert.ok(
            d >= portal.r + FOLGA,
            `${scene}: a chegada (${spawn.x}, ${spawn.z}) fica a ${d.toFixed(2)} m de ` +
            `"${portal.label}" (raio ${portal.r}) — folga mínima é ${FOLGA} m`,
          );
        }
      }
    }
  });

  it('e nasce em chão livre, não dentro do sofá', () => {
    for (const scene of scenes) {
      for (const spawn of SCENE_SPAWNS[scene] ?? []) {
        const livre = resolveCollision(
          spawn, SCENE_COLLIDERS[scene] ?? [], SCENE_AREA[scene] ?? null, PLAYER_RADIUS,
        );
        const empurrado = Math.hypot(livre.x - spawn.x, livre.z - spawn.z);
        assert.ok(
          empurrado < 1e-6,
          `${scene}: a chegada (${spawn.x}, ${spawn.z}) está dentro de um obstáculo ` +
          `(a colisão a empurraria ${empurrado.toFixed(2)} m)`,
        );
      }
    }
  });

  it('toda porta de interior fica na abertura que existe na parede', () => {
    // O arco de saída é deduzido do casco. Deduzir só a profundidade e chutar o
    // X põe a porta no meio da parede sul mesmo quando o buraco está a dois
    // metros dali — foi assim que o apartamento ganhou uma saída no meio do
    // quarto.
    for (const scene of scenes) {
      const saida = (PORTALS[scene] ?? []).find((p) => p.id === `${scene}_exit`);
      if (!saida) continue;
      const colisao = resolveCollision(
        saida, SCENE_COLLIDERS[scene] ?? [], SCENE_AREA[scene] ?? null, 0.1,
      );
      assert.ok(
        Math.hypot(colisao.x - saida.x, colisao.z - saida.z) < 1e-6,
        `${scene}: a porta de saída está dentro de uma parede ou de um móvel`,
      );
    }
  });
});

/**
 * As paradas dos bicos (PRD §26) como PLANTA.
 *
 * Um bico é uma rota por endereços do Distrito Sombra, e o defeito que ele
 * produz não aparece em tipo nenhum: o jogo compila, o bico é aceito, o
 * marcador acende — e o jogador não consegue chegar, porque a parada está
 * dentro de uma fachada. É o mesmo teste que existe para os pontos de chegada,
 * pela mesma razão: ninguém deve ser mandado a um lugar onde não cabe.
 *
 * Um segundo defeito, tão mudo quanto: um bico que aponta para uma chave que
 * não existe em `NOIR.stops`. A API responde a coordenada (0, 0) — o meio da
 * avenida — e a entrega parece funcionar no lugar errado.
 */
describe('paradas dos bicos', () => {
  it('toda parada citada por um bico existe na planta', () => {
    for (const gig of GIGS) {
      for (const stop of gig.stops) {
        assert.ok(
          NOIR.stops[stop.id],
          `${gig.id}: a parada "${stop.id}" não existe em NOIR.stops — ` +
          'a API responderia (0, 0), que é o meio da avenida',
        );
      }
    }
  });

  it('e fica em chão livre, alcançável a pé', () => {
    for (const [id, ponto] of Object.entries(NOIR.stops)) {
      const livre = resolveCollision(
        ponto, SCENE_COLLIDERS.noir_district, SCENE_AREA.noir_district ?? null, PLAYER_RADIUS,
      );
      const empurrado = Math.hypot(livre.x - ponto.x, livre.z - ponto.z);
      assert.ok(
        empurrado < 1e-6,
        `parada "${id}" (${ponto.x}, ${ponto.z}) está dentro de um obstáculo ` +
        `(a colisão empurraria ${empurrado.toFixed(2)} m) — o bico seria impossível`,
      );
    }
  });

  it('e o raio de chegada cabe dentro da rua', () => {
    // O raio é generoso de propósito (a posição do preditor oscila), mas
    // generoso demais faz duas paradas vizinhas se sobreporem — e aí uma
    // entrega cumpre a seguinte sem sair do lugar.
    const pontos = Object.entries(NOIR.stops);
    for (let i = 0; i < pontos.length; i++) {
      for (let j = i + 1; j < pontos.length; j++) {
        const [aId, a] = pontos[i];
        const [bId, b] = pontos[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        assert.ok(
          d > GIG_STOP_RADIUS * 2,
          `as paradas "${aId}" e "${bId}" estão a ${d.toFixed(1)} m — ` +
          `os raios de ${GIG_STOP_RADIUS} m se tocam e uma cumpriria a outra`,
        );
      }
    }
  });

  it('o nível de atenção paga mais e dá menos tempo, e nunca pune', () => {
    // A regra do §9 escrita como teste: subir de nível não pode tirar dinheiro
    // nem tornar a rota impossível. É a diferença entre dificuldade e castigo.
    let pagamentoAnterior = 0;
    for (let nivel = 0; nivel <= HEAT_MAX; nivel++) {
      const paga = heatPayout(100, nivel);
      const tempo = heatSeconds(100, nivel);
      assert.ok(paga >= pagamentoAnterior, `nível ${nivel} paga menos que o anterior`);
      assert.ok(tempo <= 100, `nível ${nivel} daria MAIS tempo que o nível zero`);
      // Trinta por cento é o aperto máximo, e ele é o limite do que uma rota
      // autorada aguenta antes de virar corrida contra o relógio impossível.
      assert.ok(tempo >= 70, `nível ${nivel} corta ${100 - tempo}% do tempo — passou do teto`);
      pagamentoAnterior = paga;
    }
    assert.equal(heatLevel(0), 0);
    assert.equal(heatLevel(HEAT_STEPS[0]), 1);
    assert.equal(heatLevel(1_000), HEAT_MAX, 'o nível não pode passar do teto');
  });
});
