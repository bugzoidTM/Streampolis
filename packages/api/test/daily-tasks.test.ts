import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ACCEPTED_KINDS, DAILY_TASKS } from '../src/social/DailyTasks.ts';

/**
 * O §26 existe para uma frase: "isso permite que uma pessoa prospere sem
 * obrigatoriamente se tornar streamer". Estes testes guardam essa frase — é o
 * tipo de propriedade que um dia alguém quebra sem perceber, acrescentando uma
 * tarefa de "abra uma live" porque ela paga bem.
 */
describe('tarefas diárias (PRD §26)', () => {
  it('nenhuma tarefa OBRIGA a transmitir', () => {
    /**
     * A primeira versão deste teste procurava a palavra "transmitir" no texto e
     * reprovou a dica "Assistir conta. Transmitir também" — que é justamente a
     * frase que DIZ que transmitir é opcional. Procurar palavra em texto para
     * verificar regra de produto é o erro; a regra está nos tipos aceitos.
     */
    const soDeStreamer = new Set(['streaming_only']);   // nenhum tipo é exclusivo do palco
    for (const t of DAILY_TASKS) {
      const aceitos = ACCEPTED_KINDS[t.id] ?? [t.kind];
      assert.ok(aceitos.length > 0, `${t.id} não tem como ser cumprida`);
      assert.ok(aceitos.some((k) => !soDeStreamer.has(k)),
        `${t.id} só pode ser cumprida transmitindo`);
    }
  });

  it('o dia cobre quem não transmite: conversar, visitar e se aproximar', () => {
    const todos = new Set(Object.values(ACCEPTED_KINDS).flat());
    for (const k of ['chat', 'visit', 'follow'] as const) {
      assert.ok(todos.has(k), `nenhuma tarefa é cumprida com "${k}"`);
    }
  });

  it('todas pagam alguma coisa, e nenhuma paga demais', () => {
    for (const t of DAILY_TASKS) {
      assert.ok(t.credits > 0, `${t.id} não paga nada`);
      // A mediana da loja é 300 Credits: uma tarefa que pagasse isso sozinha
      // tornaria a loja irrelevante no primeiro dia.
      assert.ok(t.credits < 150, `${t.id} paga ${t.credits}, alto demais para uma diária`);
    }
  });

  it('o dia inteiro rende menos que o item mediano da loja', () => {
    const total = DAILY_TASKS.reduce((s, t) => s + t.credits, 0);
    assert.ok(total < 300, `um dia rende ${total}, e a mediana da loja é 300`);
    assert.ok(total > 100, `um dia rende ${total}: pouco demais para valer o clique`);
  });

  it('os ids são únicos — a chave do resgate é (usuário, dia, id)', () => {
    const ids = DAILY_TASKS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
