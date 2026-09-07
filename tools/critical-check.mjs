#!/usr/bin/env node
/**
 * Os três testes que os SPECs chamam de CRÍTICOS (§61, §62, §63).
 *
 * O documento não diz "seria bom testar": ele descreve três cenários com
 * números e manda produzir um resultado específico. São os três lugares onde
 * um defeito não dá tela em branco — dá dinheiro inventado, dinheiro sumido ou
 * um placar que ninguém consegue explicar para quem perdeu.
 *
 * Nenhum deles existia. O release-check cobria idempotência (a MESMA chave duas
 * vezes), que é outra coisa: aqui o teste é a CORRIDA — duas cobranças
 * diferentes, legítimas, chegando ao mesmo tempo.
 *
 *   node tools/critical-check.mjs [--api=…] [--ws=…]
 *
 * Precisa do token de serviço (as rotas `/internal/*` são a porta do game
 * server) e do segredo do webhook. Em desenvolvimento os dois têm default; em
 * produção vêm do `.env` da stack.
 */
import { createHmac } from 'node:crypto';
import { Client } from 'colyseus.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const API = (args.api ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = (args.ws ?? 'ws://127.0.0.1:2567').replace(/\/$/, '');
const SERVICE = args.service ?? process.env.API_SERVICE_TOKEN ?? 'dev-only-service-token';
const WEBHOOK_SECRET = args.webhookSecret ?? process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-only-webhook-secret';

let falhas = 0;
let total = 0;
const check = (label, ok, detalhe = '') => {
  total++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detalhe ? ` — ${detalhe}` : ''}`);
  if (!ok) falhas++;
};
const passo = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const como = (t) => ({ authorization: `Bearer ${t}` });
const comoServico = () => ({ authorization: `Bearer ${SERVICE}` });

const STAMP = Date.now().toString(36).slice(-6);
async function conta(sufixo) {
  const username = `cc_${STAMP}_${sufixo}`;
  const { status, body } = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username, email: `${username}@critical-check.streampolis`, password: `Cc!${STAMP}#${sufixo}7`,
    }),
  });
  if (status !== 201) throw new Error(`cadastro de ${username} falhou (${status}): ${JSON.stringify(body)}`);
  return { username, ...body, userId: body.identity.userId };
}

/** Compra o pacote de 100 Coins pelo caminho do jogador. Exige provedor sandbox. */
async function comprar100(pessoa) {
  const vitrine = await api('/shop/coin-packages');
  const pacote = (vitrine.body.packages ?? []).find((p) => p.totalCoins === 100)
    ?? (vitrine.body.packages ?? [])[0];
  if (!pacote) return null;
  const intencao = await api('/me/checkout', {
    method: 'POST', headers: como(pessoa.token), body: JSON.stringify({ packageId: pacote.id }),
  });
  if (intencao.status !== 201) return null;
  await api(`/payments/sandbox/${intencao.body.paymentId}/confirm`, {
    method: 'POST', headers: como(pessoa.token),
  });
  return pacote.totalCoins;
}

const saldo = async (pessoa) => (await api('/me/wallet', { headers: como(pessoa.token) })).body.coins;

async function main() {
  console.log(`\nTestes críticos dos SPECs — ${API}`);
  const saude = await api('/health');
  if (saude.status !== 200) { console.error(`API fora do ar em ${API}`); process.exit(2); }

  // ------------------------------------------------------------- §61 ---
  passo('§61) Carteira: 100 Coins, dois gifts de 70 ao mesmo tempo');
  const gastador = await conta('a');
  const criador = await conta('b');
  const creditado = await comprar100(gastador);
  if (creditado !== 100) {
    console.log(`  · sem pacote de 100 Coins (veio ${creditado}); o cenário do §61 exige exatamente 100.`);
    console.log('    Rode a API com PAYMENTS_PROVIDER=sandbox.');
    process.exit(2);
  }
  check('o cenário começa com exatamente 100 Coins', (await saldo(gastador)) === 100);

  /**
   * Duas cobranças de 70, chaves de idempotência DIFERENTES, disparadas juntas.
   *
   * Chave diferente é o ponto: com a mesma chave isto seria o teste de
   * idempotência, que já existe. Aqui as duas cobranças são legítimas e
   * distintas — o que não pode acontecer é as duas passarem, porque 140 > 100.
   * É o clássico gasto duplo, e o que impede é o `FOR UPDATE` na carteira.
   */
  const cobranca = (n) => api('/internal/economy/gift', {
    method: 'POST', headers: comoServico(),
    body: JSON.stringify({
      idempotencyKey: `crit_${STAMP}_race_${n}`,
      senderId: gastador.userId, receiverId: criador.userId,
      giftId: 'g_coffee', quantity: 14,   // 5 Coins × 14 = 70
    }),
  });
  const [um, dois] = await Promise.all([cobranca(1), cobranca(2)]);
  const aprovados = [um, dois].filter((r) => r.status === 200 && r.body.ok !== false).length;

  check('APENAS UMA das duas cobranças é aprovada', aprovados === 1,
    `aprovadas=${aprovados} (${um.status}/${dois.status}) ${JSON.stringify([um.body, dois.body]).slice(0, 160)}`);
  const restante = await saldo(gastador);
  check('sobram exatamente 30 Coins', restante === 30, `saldo=${restante}`);
  check('e o saldo NUNCA fica negativo', restante >= 0, `saldo=${restante}`);

  const extrato = (await api('/me/ledger?limit=10', { headers: como(gastador.token) })).body.entries ?? [];
  const debitos70 = extrato.filter((e) => e.amount === -70);
  check('o extrato registra UM débito de 70, não dois', debitos70.length === 1,
    `${debitos70.length} débitos · extrato=${JSON.stringify(extrato.map((e) => e.amount))}`);

  // A terceira cobrança, agora sozinha, tem de ser recusada por saldo.
  const terceira = await cobranca(3);
  check('com 30 Coins, uma cobrança de 70 é recusada',
    terceira.status !== 200 || terceira.body.ok === false,
    `${terceira.status} ${JSON.stringify(terceira.body).slice(0, 120)}`);

  // ------------------------------------------------------------- §62 ---
  passo('§62) Webhook: o mesmo evento várias vezes credita uma vez só');
  const comprador = await conta('c');
  const vitrine = await api('/shop/coin-packages');
  const pacote = (vitrine.body.packages ?? [])[0];
  const intencao = await api('/me/checkout', {
    method: 'POST', headers: como(comprador.token), body: JSON.stringify({ packageId: pacote.id }),
  });
  check('a intenção de compra foi aberta', intencao.status === 201, JSON.stringify(intencao.body).slice(0, 120));

  const evento = JSON.stringify({
    id: `evt_${STAMP}_dup`, type: 'payment.paid', paymentId: intencao.body.paymentId,
  });
  const assinatura = createHmac('sha256', WEBHOOK_SECRET).update(evento).digest('hex');
  const entregar = () => fetch(`${API}/payments/webhook/sandbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-streampolis-signature': assinatura },
    body: evento,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  // Cinco entregas ao mesmo tempo: é o que um gateway faz quando não recebe o
  // 200 na primeira, e é o cenário exato do §62.
  const entregas = await Promise.all([entregar(), entregar(), entregar(), entregar(), entregar()]);
  const creditou = entregas.filter((r) => r.body?.result === 'credited').length;
  check('exatamente UMA entrega credita', creditou === 1,
    `creditadas=${creditou} · ${JSON.stringify(entregas.map((e) => e.body?.result))}`);
  check('as outras respondem 200 (gateway que recebe erro reenvia para sempre)',
    entregas.every((e) => e.status === 200), JSON.stringify(entregas.map((e) => e.status)));
  const saldoComprador = await saldo(comprador);
  check('a carteira recebeu o pacote uma vez só', saldoComprador === pacote.totalCoins,
    `saldo=${saldoComprador} vs pacote=${pacote.totalCoins}`);

  const semAssinatura = await fetch(`${API}/payments/webhook/sandbox`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: evento,
  });
  check('webhook sem assinatura é recusado (401)', semAssinatura.status === 401,
    `status=${semAssinatura.status}`);

  // ------------------------------------------------------------- §63 ---
  passo('§63) PK: dois presentes quase simultâneos, um resultado só');
  let liveHost = null;
  try {
    const cliente = new Client(WS);
    liveHost = await cliente.create('live', { token: criador.token, title: 'Crítico', category: 'geral' });
  } catch (err) {
    console.log(`  · game server fora do ar em ${WS}: §63 pulado (${String(err?.message ?? err).slice(0, 60)})`);
  }

  if (liveHost) {
    for (const t of ['chatMessage', 'notice', 'giftEvent', 'stageInvite', 'pkResult', 'follow']) {
      liveHost.onMessage(t, () => {});
    }
    /**
     * `await cond()` e não `cond()`: a primeira versão passava uma função
     * assíncrona aqui, e uma Promise é sempre verdadeira — a espera terminava
     * no primeiro laço e o teste media a ausência do resultado em vez de
     * esperar por ele. Passou verde por engano em dois lugares.
     */
    const espera = async (label, cond, ms = 15_000) => {
      const fim = Date.now() + ms;
      while (Date.now() < fim) { if (await cond()) return true; await sleep(80); }
      console.log(`  … tempo esgotado: ${label}`);
      return false;
    };
    await espera('a live abrir', () => liveHost.state?.liveId !== undefined);

    // O adversário e dois presenteadores com Coins comprados.
    const oponente = await conta('d');
    const doador1 = await conta('e');
    const doador2 = await conta('f');
    await Promise.all([comprar100(doador1), comprar100(doador2)]);

    const salas = [];
    for (const p of [oponente, doador1, doador2]) {
      const c = new Client(WS);
      const sala = await c.joinById(liveHost.roomId, { token: p.token });
      for (const t of ['chatMessage', 'notice', 'giftEvent', 'stageInvite', 'pkResult', 'follow']) {
        sala.onMessage(t, () => {});
      }
      salas.push(sala);
    }
    const [salaOponente, sala1, sala2] = salas;

    liveHost.send('invite', { userId: oponente.userId });
    await sleep(400);
    salaOponente.send('acceptStage', {});
    await espera('o oponente no palco', () => liveHost.state.players.size === 2);
    liveHost.send('startPK', { opponentId: oponente.userId });
    const ativo = await espera('o PK começar', () => liveHost.state.pk.phase === 'ACTIVE', 12_000);
    check('a batalha começou', ativo, `fase=${liveHost.state.pk.phase}`);

    /**
     * Dois presentes disparados no mesmo instante, de contas diferentes, para o
     * mesmo lado do placar. O §63 pede ordenação consistente e pontuação
     * atualizada: o placar tem de terminar com a SOMA exata dos dois, nem um
     * ponto a menos (perda de atualização) nem a mais (contagem dupla).
     */
    const antes = liveHost.state.pk.scoreA;
    sala1.send('gift', { giftId: 'g_heart', quantity: 1, idempotencyKey: `crit_${STAMP}_pk1` });
    sala2.send('gift', { giftId: 'g_heart', quantity: 1, idempotencyKey: `crit_${STAMP}_pk2` });
    const somou = await espera('o placar somar os dois', () => liveHost.state.pk.scoreA >= antes + 40, 15_000);
    check('o placar soma os DOIS presentes, exatamente', somou && liveHost.state.pk.scoreA === antes + 40,
      `${antes} → ${liveHost.state.pk.scoreA} (esperado ${antes + 40})`);

    // Fim da batalha: um resultado só, e coerente com o placar.
    await salaOponente.leave();
    const terminou = await espera('o PK terminar', () => liveHost.state.pk.phase === 'FINISHED', 15_000);
    check('a batalha fechou', terminou, `fase=${liveHost.state.pk.phase}`);

    let historico = [];
    await espera('o resultado ser gravado', async () => {
      historico = (await api('/me/pk', { headers: como(criador.token) })).body.matches ?? [];
      return historico.length > 0;
    }, 12_000);
    check('existe UM resultado gravado, não dois', historico.length === 1,
      `${historico.length} resultados`);
    check('e o vencedor é quem o placar apontou', historico[0]?.won === true,
      JSON.stringify(historico[0] ?? null).slice(0, 140));

    liveHost.send('endLive', {});
    await sleep(600);
    /**
     * `leave()` numa sala que o servidor JÁ desconectou (encerrar a live
     * derruba todo mundo) devolve uma promessa que nunca resolve. Esperar por
     * ela drenava o loop de eventos e o Node encerrava sozinho, com código 0 e
     * SEM imprimir o placar — um teste que "passa" sem dizer o que verificou.
     * Por isso a saída tem prazo.
     */
    const sair = (sala) => Promise.race([
      sala.leave().catch(() => {}),
      sleep(1_500),
    ]);
    for (const s of [...salas, liveHost]) await sair(s);
  }

  console.log(`\n${falhas === 0 ? '✅' : '❌'} ${total - falhas}/${total} verificações passaram.`);
  /**
   * `exitCode` e não `process.exit()`: com a saída num pipe (é assim que o
   * runner de portões lê), o exit imediato corta a escrita pendente — e a
   * linha cortada era justamente o placar. O processo termina sozinho quando os
   * sockets fecham.
   */
  process.exitCode = falhas === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\n💥 critical-check falhou:', err?.message ?? err);
  process.exit(1);
});
