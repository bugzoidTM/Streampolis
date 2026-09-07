import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkName, hasBannedTerm, normaliseText, sanitizeLiveTitle, NEUTRAL_LIVE_TITLE,
} from '../src/shared.ts';

/**
 * Os três recursos de TEXTO que o §27 lista como obrigatórios: filtro de
 * termos, moderação de username e moderação de título de live. O que estes
 * testes guardam não é a lista de palavras — é o comportamento em volta dela:
 * o que é recusado, o que é trocado, e o que NÃO pode ser recusado por engano.
 */
describe('normalização', () => {
  it('atravessa acento, leet e letra repetida', () => {
    assert.equal(normaliseText('P0RRRRA'), 'pora');
    assert.equal(normaliseText('mérda'), 'merda');
  });

  it('palavra inocente com letra dobrada não vira outra coisa', () => {
    // "carro" colapsa para "caro", e é por isso que a lista passa pela mesma
    // função: os dois lados encolhem juntos.
    assert.equal(normaliseText('carro'), 'caro');
    assert.equal(hasBannedTerm('carro'), false);
  });
});

describe('moderação de username (§27)', () => {
  it('recusa palavrão, inclusive disfarçado', () => {
    assert.equal(checkName('p0rra123'), 'termo');
    assert.equal(checkName('CARALHO'), 'termo');
    assert.equal(checkName('xX_merda_Xx'), 'termo');
  });

  it('LIMITAÇÃO CONHECIDA: derivada não é pega pelo radical', () => {
    /**
     * "merdinha" não CONTÉM "merda" — e a lista casa por substring. Isto está
     * aqui como teste, e não como comentário solto, porque é a diferença entre
     * uma lacuna conhecida e um descuido: no dia em que a lista virar serviço
     * de moderação (SPECs §39/§40), este teste é o que vai falhar e avisar que
     * o comportamento melhorou.
     */
    assert.equal(checkName('merdinha'), null);
  });

  it('recusa nome que se passa pela equipe', () => {
    // Impersonação é o caso perigoso: um "suporte" pede senha na praça e o jogo
    // teria ensinado a vítima a confiar nele.
    assert.equal(checkName('suporte'), 'reservado');
    assert.equal(checkName('moderador_oficial'), 'reservado');
    assert.equal(checkName('Streampolis'), 'reservado');
  });

  it('deixa passar nome comum', () => {
    for (const bom of ['ana', 'beto.silva', 'Carla_99', 'joao', 'MariaZ']) {
      assert.equal(checkName(bom), null, `${bom} foi recusado`);
    }
  });

  it('nome reservado CURTO não pega gente inocente pelo meio', () => {
    // "mod" casando por substring recusaria "modelo" e "modesto" — e a pessoa
    // não teria como entender o motivo. Curto casa por igualdade.
    for (const inocente of ['modelo', 'modesto', 'moda.br', 'ajudante', 'joana.moderna']) {
      assert.equal(checkName(inocente), null, `${inocente} foi recusado`);
    }
    // Mas o nome curto exato continua reservado.
    assert.equal(checkName('mod'), 'reservado');
    // E o longo continua casando por dentro: "sistemas.br" lê como o sistema
    // falando, e é exatamente o que a lista existe para impedir.
    assert.equal(checkName('sistemas.br'), 'reservado');
  });
});

describe('título de live (§27)', () => {
  it('título ruim vira neutro em vez de derrubar a live', () => {
    const r = sanitizeLiveTitle('live da porra toda');
    assert.equal(r.title, NEUTRAL_LIVE_TITLE);
    assert.equal(r.replaced, true, 'o host precisa saber que trocamos');
  });

  it('título bom passa inteiro, sem espaço sobrando', () => {
    const r = sanitizeLiveTitle('  Jogando   com os amigos  ');
    assert.equal(r.title, 'Jogando com os amigos');
    assert.equal(r.replaced, false);
  });

  it('título vazio vira neutro, e isso NÃO é troca por moderação', () => {
    const r = sanitizeLiveTitle('   ');
    assert.equal(r.title, NEUTRAL_LIVE_TITLE);
    assert.equal(r.replaced, false, 'avisar "trocamos seu título" sem ter havido título é mentira');
  });

  it('corta em 80 caracteres', () => {
    assert.equal(sanitizeLiveTitle('a'.repeat(200)).title.length, 80);
  });
});
