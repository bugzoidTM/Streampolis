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
/**
 * O bairro é ANDÁVEL de ponta a ponta.
 *
 * O teste acima prova que uma parada não está DENTRO de um prédio. Não prova a
 * outra metade, que é o defeito que uma planta escrita à mão realmente produz:
 * o lugar existe, é livre, e não há caminho até ele. Uma fatia de fachada com
 * o `x1` errado por meio metro fecha uma passagem inteira, e o sintoma é um
 * jogador correndo cem metros para descobrir que a rua não passa.
 *
 * Isso apareceu na hora exata em que o Distrito Sombra deixou de ser um
 * corredor: com duas ruas ligadas por duas passagens, existe pela primeira vez
 * a possibilidade de uma METADE do bairro ficar ilhada — e nada no
 * TypeScript, no desenho ou na colisão diria uma palavra.
 *
 * A prova é uma inundação em grade de meio metro a partir da chegada, com o
 * mesmo `resolveCollision` que o servidor usa. Meio metro é mais grosso que o
 * jogador (raio 0,28) de propósito: uma grade fina "passa" por frestas que o
 * corpo não atravessa, e um teste que aprova o que o jogo recusa é pior que
 * nenhum teste.
 */
describe('o Distrito Sombra é atravessável', () => {
  const PASSO = 0.5;

  /** Casas livres alcançáveis a pé desde o ponto de chegada. */
  function alcancavel(): Set<string> {
    const area = SCENE_AREA.noir_district;
    assert.ok(area && area.kind === 'rect', 'o bairro precisa de um retângulo andável');
    const colisores = SCENE_COLLIDERS.noir_district;
    const minX = area.x - area.hw;
    const minZ = area.z - area.hd;
    const cols = Math.floor((area.hw * 2) / PASSO);
    const linhas = Math.floor((area.hd * 2) / PASSO);

    const chave = (i: number, j: number) => `${i},${j}`;
    const livre = (i: number, j: number): boolean => {
      if (i < 0 || j < 0 || i >= cols || j >= linhas) return false;
      const p = { x: minX + (i + 0.5) * PASSO, z: minZ + (j + 0.5) * PASSO };
      const r = resolveCollision(p, colisores, area, PLAYER_RADIUS);
      return Math.hypot(r.x - p.x, r.z - p.z) < 1e-6;
    };

    const inicio = SCENE_SPAWNS.noir_district[0];
    const i0 = Math.floor((inicio.x - minX) / PASSO);
    const j0 = Math.floor((inicio.z - minZ) / PASSO);
    assert.ok(livre(i0, j0), 'o ponto de chegada do bairro não está em chão livre');

    const vistos = new Set<string>([chave(i0, j0)]);
    const fila: Array<[number, number]> = [[i0, j0]];
    while (fila.length) {
      const [i, j] = fila.pop() as [number, number];
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        const k = chave(ni, nj);
        if (vistos.has(k) || !livre(ni, nj)) continue;
        vistos.add(k);
        fila.push([ni, nj]);
      }
    }
    return vistos;
  }

  const mapa = alcancavel();
  const area = SCENE_AREA.noir_district as { x: number; z: number; hw: number; hd: number };
  const daGrade = (x: number, z: number) => `${Math.floor((x - (area.x - area.hw)) / PASSO)},`
    + `${Math.floor((z - (area.z - area.hd)) / PASSO)}`;

  it('toda parada de bico é alcançável a pé desde a chegada', () => {
    for (const [id, p] of Object.entries(NOIR.stops)) {
      assert.ok(
        mapa.has(daGrade(p.x, p.z)),
        `a parada "${id}" (${p.x}, ${p.z}) existe e é livre, mas NÃO há caminho `
        + 'até ela — provavelmente uma fatia de fachada fechou uma passagem',
      );
    }
  });

  it('as duas passagens ligam mesmo a avenida à travessa', () => {
    // Sem isto, fechar as duas passagens ainda passaria no teste acima no dia
    // em que as paradas da travessa saíssem da lista.
    for (const p of NOIR.passages) {
      const meio = (p.x0 + p.x1) / 2;
      assert.ok(mapa.has(daGrade(meio, -15)), `a boca da passagem ${p.id} está fechada`);
      assert.ok(mapa.has(daGrade(meio, -27)), `a passagem ${p.id} não chega à travessa`);
    }
    assert.ok(mapa.has(daGrade(0, NOIR.laneZ)), 'o meio da travessa não é alcançável');
  });

  it('as duas pontas da avenida são alcançáveis', () => {
    const rua = NOIR.streets[0];
    assert.ok(mapa.has(daGrade(rua.x0 + 2, 0)), 'a ponta oeste da avenida está fechada');
    assert.ok(mapa.has(daGrade(rua.x1 - 2, 0)), 'a ponta leste da avenida está fechada');
  });

  it('o beco continua SEM SAÍDA — é o que faz dele um beco', () => {
    // A regressão simétrica: alguém "abre" o beco por engano e o atalho que a
    // planta recusou aparece de graça. O fundo é alcançável; o outro lado da
    // parede, pela travessa, não pode ser alcançado ATRAVESSANDO o beco.
    const meio = (NOIR.alley.x0 + NOIR.alley.x1) / 2;
    assert.ok(mapa.has(daGrade(meio, NOIR.alley.end + 1.5)), 'o fundo do beco ficou inacessível');
    assert.ok(
      !mapa.has(daGrade(meio, NOIR.alley.end - 3)),
      'o beco virou passagem: há chão livre logo depois do fundo dele',
    );
  });
});

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
