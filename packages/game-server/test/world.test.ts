import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PORTALS, SCENE_SPAWNS, SCENE_COLLIDERS, SCENE_AREA, PLAYER_RADIUS,
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
