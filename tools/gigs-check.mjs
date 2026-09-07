/**
 * Prova dos BICOS DE RUA (PRD §26) de ponta a ponta.
 *
 * Um bico atravessa as três autoridades do projeto, e é exatamente por isso que
 * ele precisa de um teste que passe pelas três de verdade:
 *
 *   * a **API** tem a corrida, a ordem das paradas, o prazo e a carteira;
 *   * o **game server** tem a posição, e é o único que pode dizer "chegou";
 *   * o **cliente** só aceita e larga.
 *
 * Nenhum teste de unidade pega o defeito que interessa aqui, que é de COSTURA:
 * a sala não adotar a corrida de quem acabou de aceitar, o índice da parada não
 * viajar, a API pagar duas vezes. Então este script anda de verdade — ele move
 * um jogador headless pelo bairro com as mesmas intenções de movimento que o
 * teclado produz, e espera o BANCO mudar antes de conferir.
 *
 * Precisa da API (:8787) e do game server apontado para ela. Não precisa de
 * navegador: o que está sendo provado não é a tela.
 *
 *   node tools/gigs-check.mjs
 */
import { Client } from 'colyseus.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const API = args.api ?? 'http://127.0.0.1:8787';
const SERVER = args.server ?? 'ws://127.0.0.1:2567';
/**
 * O crachá de SERVIÇO, para os dois passos que batem em `/internal/*`.
 *
 * Contra a produção ele vem do ambiente. O valor de desenvolvimento fica como
 * padrão porque é o do seed e não abre nada em lugar nenhum — mas ele não pode
 * estar escrito no meio do script: seria um segredo colado, e o dia em que
 * alguém rodasse este gate contra outro alvo teria dois passos falhando com
 * 401 e nenhuma pista do motivo.
 */
const SERVICE = process.env.API_SERVICE_TOKEN ?? 'dev-only-service-token';

const checks = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const passo = (t) => console.log(`\n${t}`);

async function login(username) {
  const res = await fetch(`${API}/auth/dev-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou (${res.status})`);
  return res.json();
}

const como = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function until(fn, ms = 12_000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

/**
 * Andar até um ponto MANDANDO INTENÇÃO, como o teclado faz.
 *
 * Nada de teleporte. Um teste que empurra a posição do jogador não prova o que
 * este script existe para provar: que a sala vê a chegada de quem ANDOU até
 * lá, com a mesma colisão e o mesmo passo fixo do jogo.
 *
 * O rumo é recalculado a cada envio porque o corpo pode ter sido desviado por
 * um poste ou por uma parede — seguir um rumo calculado uma vez só faz o
 * jogador andar contra a fachada até o tempo acabar.
 *
 * O `seq` é CRESCENTE, e isso não é detalhe: o servidor descarta intenção com
 * `seq` menor ou igual ao último aceito (`stale_seq`), porque é assim que ele
 * ignora pacote que chegou fora de ordem. Com um número aleatório por envio, o
 * primeiro sorteio alto congela o corpo para sempre — o jogador anda um metro e
 * meio e para, que foi exatamente o que a primeira versão deste gate viu.
 */
let seq = 0;
async function andarAte(sala, sessionId, alvo, limiteMs = 30_000) {
  const eu = () => sala.state.players.get(sessionId);
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    const p = eu();
    if (!p) return false;
    const dx = alvo.x - p.x;
    const dz = alvo.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= 1.2) return true;
    sala.send('move', {
      seq: ++seq,
      dx: dx / d,
      dz: dz / d,
      yaw: Math.atan2(dx, dz),
      run: true,
    });
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

const ana = await login('ana');
const eu = ana.identity.userId;

passo('0) Limpando corrida de rodada anterior');
await api('/me/gigs', { method: 'DELETE', headers: como(ana.token) });

passo('1) O quadro de bicos existe e mostra a atenção');
const quadro = await api('/me/gigs', { headers: como(ana.token) });
check('GET /me/gigs responde', quadro.status === 200, `status=${quadro.status}`);
check('tem ofertas', (quadro.body.offers ?? []).length >= 3, `${quadro.body.offers?.length} ofertas`);
check('tem nível de atenção', typeof quadro.body.heat === 'number', `heat=${quadro.body.heat}`);
check('e nenhuma corrida em andamento', quadro.body.active === null,
  JSON.stringify(quadro.body.active)?.slice(0, 80));

// O bico mais curto: duas paradas, e é o que cabe num teste sem transformar o
// gate numa caminhada de quatro minutos.
const escolhido = 'entrega_expressa';

passo('2) Aceitar');
const aceite = await api('/me/gigs', {
  method: 'POST', headers: como(ana.token), body: JSON.stringify({ gigId: escolhido }),
});
check('aceitar responde 201', aceite.status === 201, `status=${aceite.status}`);
const corrida = aceite.body.run;
check('a corrida tem paradas com endereço', (corrida?.stops ?? []).every((s) => s.x !== undefined),
  JSON.stringify(corrida?.stops?.[0]));
check('e aponta para a primeira', corrida?.next?.id === corrida?.stops?.[0]?.id, corrida?.next?.id);

passo('3) Um bico por vez — a garantia é do banco, não de um if');
const segundo = await api('/me/gigs', {
  method: 'POST', headers: como(ana.token), body: JSON.stringify({ gigId: 'volta_completa' }),
});
check('aceitar o segundo é recusado (409)', segundo.status === 409, `status=${segundo.status}`);

passo('4) Entrar no bairro e ANDAR até as paradas');
const client = new Client(SERVER);
const sala = await client.joinOrCreate('city', { token: ana.token, sceneId: 'noir_district' });
// `join()` devolve a sala ANTES do primeiro patch: ali `state` ainda não existe
// (e, quando existe, traz os defaults do schema). É a mesma armadilha que o
// cliente paga com `connection.ready`.
await until(() => sala.state?.players?.size > 0, 15_000);
const meu = sala.state.players.get(sala.sessionId);
check('a sala é o Distrito Sombra', sala.state.sceneId === 'noir_district', sala.state.sceneId);
check('e o corpo da Ana está nela', Boolean(meu), sala.sessionId);

// A sala adota a corrida no join; o `gigSync` é o caminho de quem aceita com o
// jogo já aberto, e é ele que este gate exercita — é o mais fácil de quebrar.
sala.send('gigSync', {});
await new Promise((r) => setTimeout(r, 600));

let entregue = null;
let avancos = 0;
sala.onMessage('gigUpdate', (u) => {
  if (u.accepted && !u.delivered) avancos++;
  if (u.delivered) entregue = u;
});

const saldoAntes = (await api('/me', { headers: como(ana.token) })).body.wallet?.credits ?? 0;

for (const [i, parada] of corrida.stops.entries()) {
  const chegou = await andarAte(sala, sala.sessionId, { x: parada.x, z: parada.z });
  const onde = sala.state.players.get(sala.sessionId);
  check(`andou até a parada ${i + 1} (${parada.label})`, chegou,
    `${onde.x.toFixed(1)}, ${onde.z.toFixed(1)}`);
  // A sala amostra a 4 Hz e a resposta da API leva uma ida e volta; esperar o
  // EFEITO é o que faz este gate não depender do relógio da máquina.
  await until(() => (i + 1 === corrida.stops.length ? entregue : avancos >= i + 1), 10_000);
}

passo('5) A entrega pagou — e o pagamento veio do LEDGER');
check('a sala anunciou a entrega', entregue !== null, JSON.stringify(entregue)?.slice(0, 120));
check('com o valor combinado no aceite', entregue?.credits === corrida.credits,
  `${entregue?.credits} vs ${corrida.credits}`);

const depois = await until(async () => {
  const saldo = (await api('/me', { headers: como(ana.token) })).body.wallet?.credits ?? 0;
  return saldo > saldoAntes ? saldo : null;
}, 10_000);
check('e a carteira do servidor subiu', depois !== null, `${saldoAntes} → ${depois}`);
check('exatamente o valor do bico', depois - saldoAntes === corrida.credits,
  `+${depois - saldoAntes}`);

passo('6) A corrida fechou e não paga de novo');
const fim = await api('/me/gigs', { headers: como(ana.token) });
check('não há mais corrida em andamento', fim.body.active === null, JSON.stringify(fim.body.active));
check('a atenção subiu com a entrega', fim.body.runsInWindow >= 1, `${fim.body.runsInWindow} na janela`);

// Repetir a última chegada pela porta interna: é o caminho que uma repetição de
// rede tomaria, e ele não pode pagar duas vezes.
const repetida = await api('/internal/gigs/checkpoint', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE}` },
  body: JSON.stringify({ userId: eu, gigId: escolhido, stopIndex: corrida.stops.length - 1 }),
});
check('repetir a chegada não é aceito', repetida.body?.accepted === false,
  JSON.stringify(repetida.body)?.slice(0, 100));
const saldoFinal = (await api('/me', { headers: como(ana.token) })).body.wallet?.credits ?? 0;
check('e não pagou de novo', saldoFinal === depois, `${depois} → ${saldoFinal}`);

passo('7) Uma parada FORA DE ORDEM não conta');
await api('/me/gigs', {
  method: 'POST', headers: como(ana.token), body: JSON.stringify({ gigId: 'volta_completa' }),
});
const pulando = await api('/internal/gigs/checkpoint', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE}` },
  body: JSON.stringify({ userId: eu, gigId: 'volta_completa', stopIndex: 3 }),
});
check('chegar na última parada primeiro é recusado', pulando.body?.accepted === false,
  JSON.stringify(pulando.body)?.slice(0, 100));
const aindaCorrendo = await api('/me/gigs', { headers: como(ana.token) });
check('e a corrida continua na primeira parada', aindaCorrendo.body.active?.stopsDone === 0,
  `stopsDone=${aindaCorrendo.body.active?.stopsDone}`);

await api('/me/gigs', { method: 'DELETE', headers: como(ana.token) });
await sala.leave();

const falhas = checks.filter((c) => !c).length;
console.log(`\n${checks.length - falhas}/${checks.length} verificações passaram`);
process.exit(falhas === 0 ? 0 : 1);
