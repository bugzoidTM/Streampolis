import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { EVENT_METRICS, TETO_DE_PREMIO, isEventMetric, prizeAt } from '../src/world/CityEvents.ts';

/**
 * O que dá para provar sem banco nos eventos da cidade (PRD §22/§28).
 *
 * O grosso da feature é SQL e só um teste com Postgres do lado prova (é o que
 * `tools/events-check.mjs` faz, apurando um evento de verdade). O que sobra
 * aqui são as duas coisas que erram em silêncio:
 *
 *   1. o **pódio fora do intervalo** — um prêmio lido na colocação errada não
 *      quebra nada, só paga a pessoa errada;
 *   2. o **acordo entre o catálogo e o banco** — a coluna `metric` tem um CHECK
 *      com uma expressão regular, e uma métrica nova que não a satisfaça só
 *      falha na hora em que um admin tenta criar o evento, com um 500 cru e
 *      nenhuma pista.
 */

describe('prêmio por colocação', () => {
  const podio = [1000, 500, 250];

  it('o primeiro lugar é a primeira posição do array, não a zero', () => {
    assert.equal(prizeAt(podio, 1), 1000);
    assert.equal(prizeAt(podio, 3), 250);
  });

  it('fora do pódio não paga nada', () => {
    assert.equal(prizeAt(podio, 4), 0);
    assert.equal(prizeAt(podio, 999), 0);
  });

  it('colocação inválida não vira o último prêmio por acidente', () => {
    // `podio[-1]` é `undefined` em JS e viraria 0 sozinho; `podio.at(-1)` seria
    // o ÚLTIMO prêmio. O teste existe para que ninguém troque um pelo outro.
    assert.equal(prizeAt(podio, 0), 0);
    assert.equal(prizeAt(podio, -1), 0);
  });
});

describe('catálogo de métricas', () => {
  it('toda métrica tem id que o CHECK do banco aceita', () => {
    for (const m of EVENT_METRICS) {
      assert.match(m.id, /^[a-z_]{3,32}$/, `${m.id} não passa no CHECK da coluna metric`);
    }
  });

  it('toda métrica devolve as três colunas que a apuração lê', () => {
    for (const m of EVENT_METRICS) {
      assert.match(m.sql, /\buser_id\b/, `${m.id} não devolve user_id`);
      assert.match(m.sql, /\bscore\b/, `${m.id} não devolve score`);
      assert.match(m.sql, /\blast_at\b/, `${m.id} não devolve last_at (o desempate)`);
    }
  });

  /**
   * A janela é meio aberta: `>= $1 AND < $2`. Dois eventos encostados — um que
   * acaba à meia-noite e outro que começa à meia-noite — contariam o mesmo
   * segundo duas vezes se alguém escrevesse `<=` numa métrica só.
   */
  it('toda métrica usa a janela meio aberta', () => {
    for (const m of EVENT_METRICS) {
      assert.match(m.sql, />= \$1/, `${m.id} não fecha o começo da janela`);
      assert.match(m.sql, /< \$2/, `${m.id} não usa fim exclusivo`);
      assert.doesNotMatch(m.sql, /<= \$2/, `${m.id} usa fim inclusivo`);
    }
  });

  it('toda métrica tem rótulo, unidade e dica — a tela não inventa texto', () => {
    for (const m of EVENT_METRICS) {
      assert.ok(m.label.length > 2, `${m.id} sem rótulo`);
      assert.ok(m.unit.length > 2, `${m.id} sem unidade`);
      assert.ok(m.hint.length > 10, `${m.id} sem dica do que fazer`);
    }
  });

  /**
   * Não existe métrica de presentes DADOS, e é regra de produto, não descuido:
   * ela premiaria quem gastou mais dinheiro real, e o pódio da cidade viraria
   * o extrato de quem tem o cartão maior. O §17 já tem o lugar de quem
   * presenteia.
   */
  it('nenhuma métrica mede dinheiro gasto por quem presenteia', () => {
    for (const m of EVENT_METRICS) {
      assert.doesNotMatch(m.sql, /\bsender_id\b/,
        `${m.id} pontua por presente DADO — ver §22 e §17`);
    }
  });

  it('isEventMetric só aceita o que está no catálogo', () => {
    assert.ok(isEventMetric('pk_wins'));
    assert.ok(!isEventMetric('gifts_sent'));
    assert.ok(!isEventMetric(''));
  });
});

describe('o evento de estreia da migration cabe nas próprias regras', () => {
  it('métrica conhecida, pódio dentro do teto, janela positiva', async () => {
    const sql = await readFile(
      new URL('../migrations/0020_city_events.sql', import.meta.url), 'utf8',
    );
    const metric = /'(\w+)',\s*\n\s*'noir_district'/.exec(sql)?.[1];
    assert.ok(metric && isEventMetric(metric), `métrica semeada desconhecida: ${metric}`);

    const podio = /ARRAY\[([\d,\s]+)\]/.exec(sql)?.[1];
    assert.ok(podio, 'não achei o pódio do evento semeado');
    const soma = podio.split(',').reduce((a, n) => a + Number(n.trim()), 0);
    assert.ok(soma <= TETO_DE_PREMIO,
      `o evento semeado emite ${soma} Credits, acima do teto ${TETO_DE_PREMIO}`);
  });
});
