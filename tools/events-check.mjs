/**
 * Prova dos EVENTOS DA CIDADE (PRD §22, §28) de ponta a ponta.
 *
 * Um evento é a única coisa do jogo que **emite Credits sem ninguém pedir**: a
 * apuração paga sozinha, para várias pessoas de uma vez, num instante em que
 * talvez ninguém esteja olhando. Nenhum teste de unidade pega o defeito que
 * interessa nisso, que é de COSTURA e de dinheiro:
 *
 *   * a ordem do pódio sair diferente do placar que a tela mostrava;
 *   * a apuração rodar duas vezes e pagar duas vezes;
 *   * o evento fechar e a fama de quem subiu não mexer.
 *
 * Então este script cria um evento de VERDADE, com janela de poucos segundos,
 * mexe nos fatos que ele mede, espera o relógio virar e confere o banco pela
 * API — inclusive apurando duas vezes de propósito.
 *
 * A métrica escolhida é `followers_gained` porque é a única que se produz sem
 * game server, sem navegador e sem gastar Coins: `PUT /users/:id/follow`. O que
 * está sendo provado é a apuração, não o que virou ponto.
 *
 * Precisa só da API (:8787), com o seed aplicado.
 *
 *   node tools/events-check.mjs
 */

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));

const API = args.api ?? 'http://127.0.0.1:8787';
/**
 * `dev-login` não abre conta de equipe de propósito (ver `admin-check.mjs`), e
 * criar evento é rota de equipe. Então a senha do seed entra aqui pelo mesmo
 * caminho que lá — env primeiro, valor de desenvolvimento como último recurso.
 */
const STAFF_PASSWORD = process.env.STAFF_PASSWORD ?? 'streampolis-dev';

const checks = [];
const check = (label, ok, detail) => {
  checks.push(ok);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};
const passo = (t) => console.log(`\n${t}`);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const como = (token) => ({ authorization: `Bearer ${token}` });

async function entrar(username) {
  const { status, body } = await api('/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ username }),
  });
  if (status !== 200) throw new Error(`login de ${username} falhou (${status}) — rode npm run seed`);
  return { token: body.accessToken ?? body.token, id: body.identity?.userId ?? body.identity?.id };
}

async function entrarComSenha(username) {
  const { status, body } = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password: STAFF_PASSWORD }),
  });
  if (status !== 200) throw new Error(`login de ${username} falhou (${status})`);
  return { token: body.accessToken ?? body.token, id: body.identity?.userId ?? body.identity?.id };
}

const creditosDe = async (token) => (await api('/me/wallet', { headers: como(token) })).body.credits ?? 0;
const famaDe = async (token) => (await api('/me/fame', { headers: como(token) })).body.fame ?? 0;

async function main() {
  console.log(`\nEventos da cidade — ${API}`);

  const [ana, beto, caio, mod] = await Promise.all([
    entrar('ana'), entrar('beto'), entrar('caio'), entrarComSenha('moderador'),
  ]);

  // ------------------------------------------------------------------------
  passo('1. O quadro é vitrine: responde sem sessão');
  const publico = await api('/events');
  check('GET /events sem token responde 200', publico.status === 200, `status=${publico.status}`);
  check('e traz as três listas', Array.isArray(publico.body.running)
    && Array.isArray(publico.body.upcoming) && Array.isArray(publico.body.recent));
  check('sem sessão não existe linha "você"',
    (publico.body.running ?? []).every((e) => e.you === null));

  // ------------------------------------------------------------------------
  passo('2. Criar evento é rota de equipe');
  const slug = `check-${Date.now().toString(36)}`;
  const JANELA_MS = 6000;
  const corpo = {
    slug,
    title: 'Prova de apuração',
    flavor: 'Evento de teste criado por tools/events-check.mjs.',
    metric: 'followers_gained',
    startsAt: new Date(Date.now() - 1000).toISOString(),
    endsAt: new Date(Date.now() + JANELA_MS).toISOString(),
    podium: [300, 150],
    minScore: 1,
  };

  const semToken = await api('/admin/events', { method: 'POST', body: JSON.stringify(corpo) });
  check('sem token, 401', semToken.status === 401, `status=${semToken.status}`);
  const comoJogador = await api('/admin/events', {
    method: 'POST', headers: como(ana.token), body: JSON.stringify(corpo),
  });
  check('com token de jogador, 403', comoJogador.status === 403, `status=${comoJogador.status}`);

  const criado = await api('/admin/events', {
    method: 'POST', headers: como(mod.token), body: JSON.stringify(corpo),
  });
  check('com token de equipe, 201', criado.status === 201, `status=${criado.status}`);
  const eventId = criado.body.event?.id;
  check('o evento nasce correndo', criado.body.event?.phase === 'running',
    `phase=${criado.body.event?.phase}`);

  const metricaFalsa = await api('/admin/events', {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ ...corpo, slug: `${slug}-x`, metric: 'nao_existe' }),
  });
  check('métrica desconhecida é recusada (400)', metricaFalsa.status === 400,
    `status=${metricaFalsa.status}`);

  const colide = await api('/admin/events', {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ ...corpo, slug: `${slug}-y` }),
  });
  check('janela que colide na MESMA métrica é recusada (409)', colide.status === 409,
    `status=${colide.status}`);

  // ------------------------------------------------------------------------
  passo('3. O placar é uma consulta sobre fatos que já aconteciam');
  /**
   * Caio ganha dois seguidores, Beto ganha um.
   *
   * O `deixar de seguir` antes não é higiene: o seed já deixa gente seguindo
   * gente, e um follow ANTIGO tem `created_at` fora da janela do evento — ele
   * não pontuaria, e o gate acusaria a apuração de um defeito que é do
   * cenário. Voltar a seguir dentro da janela é o que produz o fato medido.
   */
  const seguir = (quem, alvo, following) => api(`/users/${alvo}/follow`, {
    method: 'PUT', headers: como(quem), body: JSON.stringify({ following }),
  });
  await Promise.all([
    seguir(ana.token, caio.id, false),
    seguir(beto.token, caio.id, false),
    seguir(ana.token, beto.id, false),
  ]);
  await seguir(ana.token, caio.id, true);
  await seguir(beto.token, caio.id, true);
  await seguir(ana.token, beto.id, true);
  // De novo, de propósito: seguir duas vezes é idempotente e não pode virar
  // dois pontos — é o defeito mais fácil de um placar que soma linhas.
  await seguir(ana.token, caio.id, true);

  const vivo = await api(`/events/${slug}`, { headers: como(caio.token) });
  const placar = vivo.body.standings ?? [];
  check('o placar vivo tem gente sem ninguém ter anotado nada', placar.length >= 2,
    `${placar.length} colocados`);
  check('quem ganhou mais seguidores lidera', placar[0]?.userId === caio.id,
    `1º = ${placar[0]?.displayName}`);
  check('seguir duas vezes não vira dois pontos', placar[0]?.score === 2,
    `score=${placar[0]?.score}`);
  check('a linha "você" aparece para quem tem sessão', vivo.body.you?.userId === caio.id);
  check('o prêmio projetado é o do pódio', vivo.body.you?.credits === 300,
    `credits=${vivo.body.you?.credits}`);
  check('projeção não é pagamento', vivo.body.you?.awarded === false);

  const antesCaio = await creditosDe(caio.token);
  const antesBeto = await creditosDe(beto.token);
  const famaAntes = await famaDe(caio.token);

  // ------------------------------------------------------------------------
  passo('4. Vencido o prazo, quem abre o quadro dispara a apuração');
  await espera(JANELA_MS + 500);

  const depois = await api('/events', { headers: como(caio.token) });
  const apurado = (depois.body.recent ?? []).find((e) => e.slug === slug);
  check('o evento saiu de "no ar" e foi para "encerrados"', Boolean(apurado),
    apurado ? `phase=${apurado.phase}` : 'não achei na lista');
  check('o pódio ficou congelado com dois nomes', (apurado?.standings ?? []).length === 2,
    `${(apurado?.standings ?? []).length} premiados`);
  check('o 1º do pódio é o 1º que o placar mostrava',
    apurado?.standings?.[0]?.userId === caio.id);
  check('agora o prêmio está marcado como pago', apurado?.standings?.[0]?.awarded === true);

  const pagoCaio = await creditosDe(caio.token);
  const pagoBeto = await creditosDe(beto.token);
  check('o 1º lugar recebeu 300 Credits', pagoCaio - antesCaio === 300,
    `${antesCaio} → ${pagoCaio}`);
  check('o 2º lugar recebeu 150 Credits', pagoBeto - antesBeto === 150,
    `${antesBeto} → ${pagoBeto}`);

  // ------------------------------------------------------------------------
  passo('5. Apurar de novo NÃO paga de novo (é a trava que protege dinheiro)');
  const denovo = await api(`/admin/events/${eventId}/settle`, {
    method: 'POST', headers: como(mod.token),
  });
  check('o botão de apurar responde 200', denovo.status === 200, `status=${denovo.status}`);
  await api('/events', { headers: como(caio.token) });
  const terceira = await creditosDe(caio.token);
  check('o saldo não mexeu na segunda apuração', terceira === pagoCaio,
    `${pagoCaio} → ${terceira}`);

  // ------------------------------------------------------------------------
  passo('6. Pódio vira fama (PRD §22, a oitava fonte)');
  const famaDepois = await famaDe(caio.token);
  check('subir no pódio aumentou a fama', famaDepois > famaAntes,
    `${famaAntes} → ${famaDepois}`);
  const perfil = await api(`/users/${caio.id}`);
  check('e o perfil público mostra a fama nova',
    (perfil.body.profile?.fame ?? 0) >= famaDepois, `perfil=${perfil.body.profile?.fame}`);

  // ------------------------------------------------------------------------
  passo('7. Evento apurado não se desmarca — o dinheiro já saiu');
  const tardio = await api(`/admin/events/${eventId}/cancel`, {
    method: 'POST', headers: como(mod.token),
  });
  check('cancelar depois de apurar é recusado (409)', tardio.status === 409,
    `status=${tardio.status}`);

  const futuro = await api('/admin/events', {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({
      ...corpo, slug: `${slug}-z`, metric: 'pk_wins',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
    }),
  });
  check('evento marcado para o futuro nasce "a caminho"',
    futuro.body.event?.phase === 'upcoming', `phase=${futuro.body.event?.phase}`);
  const cancelado = await api(`/admin/events/${futuro.body.event?.id}/cancel`, {
    method: 'POST', headers: como(mod.token),
  });
  check('esse sim se desmarca', cancelado.status === 200, `status=${cancelado.status}`);
  const sumiu = await api('/events');
  check('e some do quadro',
    !(sumiu.body.upcoming ?? []).some((e) => e.slug === `${slug}-z`));

  // ------------------------------------------------------------------------
  const falhas = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - falhas}/${checks.length} verificações passaram`);
  if (falhas > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
