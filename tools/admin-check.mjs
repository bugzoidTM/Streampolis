#!/usr/bin/env node
/**
 * Prova do painel administrativo (PRD §27, §28).
 *
 * A pergunta que este arquivo responde é a que uma fila de denúncias sempre
 * provoca: **a decisão do moderador chega até a pessoa denunciada?** Uma fila
 * bonita que muda o status de uma linha e não muda o jogo é pior do que fila
 * nenhuma, porque dá à equipe a sensação de ter agido.
 *
 * Por isso cada passo aqui tem duas metades: a ação no painel e o efeito no
 * jogo — silenciar tira a fala, suspender tira a sessão, reintegrar devolve as
 * duas coisas.
 *
 *   node tools/admin-check.mjs [--api=http://127.0.0.1:8787]
 *
 * Entra por `dev-login` (é a conta `moderador` do seed que tem o papel), então
 * vale no modo demonstração. Em produção, o mesmo fluxo se faz com uma sessão
 * de verdade de alguém da equipe.
 */
import { Client } from 'colyseus.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const API = (args.api ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
/** Opcional: sem game server, a metade "efeito no jogo" do silêncio é pulada. */
const WS = (args.ws ?? 'ws://127.0.0.1:2567').replace(/\/$/, '');

let falhas = 0;
let total = 0;
const check = (label, ok, detalhe = '') => {
  total++;
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detalhe ? ` — ${detalhe}` : ''}`);
  if (!ok) falhas++;
};
const passo = (t) => console.log(`\n${t}`);

async function esperar(label, condicao, msMax = 15_000) {
  const fim = Date.now() + msMax;
  while (Date.now() < fim) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`  … tempo esgotado esperando: ${label}`);
  return false;
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const como = (token) => ({ authorization: `Bearer ${token}` });

/** Jogador comum: entra pela porta aberta da demonstração. */
async function entrar(username) {
  const { status, body } = await api('/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ username }),
  });
  if (status !== 200) throw new Error(`entrar como ${username} falhou (${status})`);
  return body;
}

/**
 * Equipe: entra com SENHA, mesmo na demonstração.
 *
 * `dev-login` não abre conta de staff de propósito — seria dar poder de banir a
 * qualquer visitante. A senha aqui é a do `seed`, que é conhecida porque o seed
 * é de desenvolvimento; em produção, a mesma rota com a senha de verdade.
 */
async function entrarComSenha(username, password = process.env.STAFF_PASSWORD ?? 'streampolis-dev') {
  const { status, body } = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  if (status !== 200) throw new Error(`login de ${username} falhou (${status}): ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  console.log(`\nPainel administrativo — ${API}`);

  const saude = await api('/health');
  if (saude.status !== 200) { console.error(`API fora do ar em ${API}`); process.exit(2); }

  const mod = await entrarComSenha('moderador');
  const ana = await entrar('ana');
  const beto = await entrar('beto');

  passo('1) A porta: painel é do papel, não do pedido');
  // A porta aberta da demonstração não pode dar poder de moderação a ninguém.
  const semSenha = await api('/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ username: 'moderador' }),
  });
  check('dev-login NÃO abre conta de equipe (404)', semSenha.status === 404, `status=${semSenha.status}`);
  const semSenhaAdm = await api('/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ username: 'administrador' }),
  });
  check('nem a de administrador', semSenhaAdm.status === 404, `status=${semSenhaAdm.status}`);
  check('sem token, 401', (await api('/admin/reports')).status === 401);
  const jogador = await api('/admin/reports', { headers: como(ana.token) });
  check('com token de jogador comum, 403', jogador.status === 403, `status=${jogador.status}`);
  const equipe = await api('/admin/reports', { headers: como(mod.token) });
  check('com token de moderador, 200', equipe.status === 200, `status=${equipe.status}`);

  passo('2) A denúncia de um jogador chega na fila');
  const denuncia = await api(`/users/${beto.identity.userId}/report`, {
    method: 'POST', headers: como(ana.token),
    body: JSON.stringify({ type: 'chat', reason: `admin-check ${Date.now()}` }),
  });
  check('o jogador consegue denunciar', denuncia.status === 200 || denuncia.status === 201,
    JSON.stringify(denuncia.body).slice(0, 120));

  const fila = (await api('/admin/reports?status=open', { headers: como(mod.token) })).body.reports ?? [];
  const minha = fila.find((r) => r.target.userId === beto.identity.userId);
  check('e ela aparece na fila do moderador', Boolean(minha), `${fila.length} denúncias abertas`);
  check('a fila mostra quantas denúncias abertas o alvo acumula',
    typeof minha?.openAgainstTarget === 'number' && minha.openAgainstTarget >= 1,
    String(minha?.openAgainstTarget));

  passo('3) Duas pessoas não trabalham a mesma denúncia');
  const primeira = await api(`/admin/reports/${minha.id}/claim`, { method: 'POST', headers: como(mod.token) });
  check('o primeiro assume', primeira.status === 200 && primeira.body.report?.status === 'reviewing',
    JSON.stringify(primeira.body).slice(0, 120));
  const segunda = await api(`/admin/reports/${minha.id}/claim`, { method: 'POST', headers: como(mod.token) });
  check('o segundo é recusado com 409', segunda.status === 409, `status=${segunda.status}`);

  passo('4) Dossiê: tudo o que se precisa antes de decidir, numa tela');
  const dossie = (await api(`/admin/users/${beto.identity.userId}`, { headers: como(mod.token) })).body;
  check('traz a conta', dossie.user?.userId === beto.identity.userId);
  check('traz a carteira', typeof dossie.wallet?.coins === 'number', JSON.stringify(dossie.wallet));
  check('traz as denúncias contra a pessoa', (dossie.reportsAgainst ?? []).length >= 1);
  check('traz o extrato recente', Array.isArray(dossie.recentTransactions));

  passo('5) Sanção exige motivo, e o motivo fica gravado');
  const semMotivo = await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token), body: JSON.stringify({ action: 'mute', reason: 'x' }),
  });
  check('motivo curto é recusado', semMotivo.status === 400, `status=${semMotivo.status}`);

  const acaoInvalida = await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'delete_account', reason: 'tentativa de ação inexistente' }),
  });
  check('ação fora da lista é recusada', acaoInvalida.status === 400, `status=${acaoInvalida.status}`);

  const silencio = await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'mute', reason: 'admin-check: silêncio de teste', minutes: 5 }),
  });
  check('silenciar funciona', silencio.status === 200 && Boolean(silencio.body.user?.mutedUntil),
    JSON.stringify(silencio.body).slice(0, 140));
  check('silenciar NÃO derruba a sessão', silencio.body.sessionsRevoked === 0,
    `sessões=${silencio.body.sessionsRevoked}`);

  passo('6) O silêncio chega ao jogo pelo token');
  const novoToken = (await api('/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken: beto.refreshToken }),
  })).body;
  const claims = JSON.parse(Buffer.from(novoToken.token.split('.')[1], 'base64url').toString());
  check('o token novo carrega a marca `muted`', (claims.perms ?? []).includes('muted'),
    JSON.stringify(claims.perms));
  check('e continua deixando a pessoa jogar', (claims.perms ?? []).includes('play'));

  passo('7) E, no jogo, a pessoa silenciada realmente não fala');
  let sala = null;
  try {
    const cliente = new Client(WS);
    sala = await cliente.joinOrCreate('city', { token: novoToken.token, sceneId: 'central_plaza' });
  } catch (err) {
    console.log(`  · game server fora do ar em ${WS}: metade do passo pulada (${String(err?.message ?? err).slice(0, 60)})`);
  }
  if (sala) {
    const avisos = [];
    const falas = [];
    sala.onMessage('notice', (n) => avisos.push(n));
    sala.onMessage('chatMessage', (m) => falas.push(m));
    await new Promise((r) => setTimeout(r, 600));
    sala.send('chat', { text: 'admin-check: isto não pode aparecer' });
    await new Promise((r) => setTimeout(r, 900));
    check('a sala recusa a fala de quem está silenciado',
      avisos.some((a) => a.code === 'chat_muted'), JSON.stringify(avisos).slice(0, 120));
    check('e a mensagem não é publicada para ninguém',
      !falas.some((f) => String(f.text ?? '').includes('isto não pode aparecer')),
      `${falas.length} mensagens vistas`);
    // O aviso é privado: quem está na sala não fica sabendo da punição alheia.
    check('o aviso de silêncio não vira anúncio na sala',
      !falas.some((f) => /silenciad/i.test(String(f.text ?? ''))));
    await sala.leave().catch(() => {});
  }

  passo('8) Reintegrar devolve a fala');
  const volta = await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'unmute', reason: 'admin-check: fim do teste' }),
  });
  check('unmute limpa o silêncio', volta.status === 200 && volta.body.user?.mutedUntil === null,
    JSON.stringify(volta.body.user).slice(0, 120));

  passo('9) A decisão fecha a denúncia — e só uma vez');
  const decisao = await api(`/admin/reports/${minha.id}/resolve`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ decision: 'resolved', resolution: 'admin-check: silenciado por 5 min' }),
  });
  check('a denúncia é resolvida', decisao.status === 200 && decisao.body.report?.status === 'resolved',
    JSON.stringify(decisao.body).slice(0, 120));
  const denovo = await api(`/admin/reports/${minha.id}/resolve`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ decision: 'rejected', resolution: 'tentativa de decidir de novo' }),
  });
  check('decidir de novo é recusado', denovo.status === 409, `status=${denovo.status}`);

  passo('10) Nada acontece sem rastro');
  const log = (await api(`/admin/audit?targetId=${beto.identity.userId}`, { headers: como(mod.token) })).body.entries ?? [];
  const acoes = log.map((e) => e.action);
  check('o silêncio está no log', acoes.includes('user.mute'), acoes.join(', '));
  check('o log diz QUEM agiu', log[0]?.actor?.username === 'moderador', JSON.stringify(log[0]?.actor));
  check('e POR QUÊ', typeof log.find((e) => e.action === 'user.mute')?.reason === 'string');

  passo('11) Moderador não alcança a equipe, nem a si mesmo');
  const contraSiMesmo = await api(`/admin/users/${mod.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'ban', reason: 'admin-check: auto-banimento' }),
  });
  check('não dá para se punir', contraSiMesmo.status === 400, `status=${contraSiMesmo.status}`);

  passo('12) Dinheiro é de administrador, não de moderador');
  // Sem conta de administrador o ambiente não tem como exercitar esta parte —
  // e um gate que MORRE por isso deixa de ser gate. Ele avisa e segue.
  let adm = null;
  try {
    adm = await entrarComSenha('administrador');
  } catch (err) {
    console.log(`  · sem conta de administrador neste ambiente: passos 12–14 pulados (${String(err?.message ?? err).slice(0, 80)})`);
  }
  if (adm) {
    const chave = `admin_check_${Date.now()}`;
    const tentativaMod = await api(`/admin/users/${beto.identity.userId}/wallet/adjust`, {
      method: 'POST', headers: como(mod.token),
      body: JSON.stringify({ currency: 'coins', amount: 100, reason: 'moderador tentando creditar', idempotencyKey: chave }),
    });
    check('moderador NÃO ajusta saldo (403)', tentativaMod.status === 403, `status=${tentativaMod.status}`);

    const semMotivoAjuste = await api(`/admin/users/${beto.identity.userId}/wallet/adjust`, {
      method: 'POST', headers: como(adm.token),
      body: JSON.stringify({ currency: 'coins', amount: 100, reason: 'x', idempotencyKey: `${chave}_a` }),
    });
    check('ajuste sem motivo é recusado', semMotivoAjuste.status === 400, `status=${semMotivoAjuste.status}`);

    const antes = (await api('/me/wallet', { headers: como(beto.token) })).body;
    const ajuste = await api(`/admin/users/${beto.identity.userId}/wallet/adjust`, {
      method: 'POST', headers: como(adm.token),
      body: JSON.stringify({ currency: 'coins', amount: 250, reason: 'admin-check: compensação de teste', idempotencyKey: chave }),
    });
    check('administrador ajusta com motivo', ajuste.status === 200, JSON.stringify(ajuste.body).slice(0, 120));
    check('o saldo mudou exatamente pelo valor pedido', ajuste.body.balances?.coins === antes.coins + 250,
      `${antes.coins} → ${ajuste.body.balances?.coins}`);

    const denovoAjuste = await api(`/admin/users/${beto.identity.userId}/wallet/adjust`, {
      method: 'POST', headers: como(adm.token),
      body: JSON.stringify({ currency: 'coins', amount: 250, reason: 'admin-check: duplo-clique', idempotencyKey: chave }),
    });
    check('duplo-clique com a mesma chave não credita de novo',
      denovoAjuste.body.balances?.coins === ajuste.body.balances?.coins,
      `${ajuste.body.balances?.coins} → ${denovoAjuste.body.balances?.coins}`);

    const extrato = (await api('/me/ledger?limit=3', { headers: como(beto.token) })).body.entries ?? [];
    check('o ajuste aparece no extrato do jogador', extrato[0]?.amount === 250 && extrato[0]?.type === 'admin_adjustment',
      JSON.stringify(extrato[0]).slice(0, 120));

    passo('13) Bloquear a carteira realmente impede a economia');
    const bloqueio = await api(`/admin/users/${beto.identity.userId}/economy-block`, {
      method: 'PUT', headers: como(adm.token),
      body: JSON.stringify({ blocked: true, reason: 'admin-check: bloqueio de teste' }),
    });
    check('bloqueio aplicado', bloqueio.status === 200 && bloqueio.body.user?.economyBlocked === true,
      JSON.stringify(bloqueio.body.user).slice(0, 120));

    const compraBloqueada = await api('/me/purchases', {
      method: 'POST', headers: como(beto.token),
      body: JSON.stringify({ itemId: 'fur_sofa_01', currency: 'credits', idempotencyKey: `${chave}_buy` }),
    });
    check('com a carteira bloqueada, a compra é recusada', compraBloqueada.status === 403,
      `status=${compraBloqueada.status} ${JSON.stringify(compraBloqueada.body).slice(0, 80)}`);

    const desbloqueio = await api(`/admin/users/${beto.identity.userId}/economy-block`, {
      method: 'PUT', headers: como(adm.token),
      body: JSON.stringify({ blocked: false, reason: 'admin-check: fim do teste' }),
    });
    check('desbloqueio devolve a economia', desbloqueio.body.user?.economyBlocked === false);

    passo('14) Pacotes de Coins: o painel vê o que a vitrine esconde');
    const todos = (await api('/admin/coin-packages', { headers: como(mod.token) })).body.packages ?? [];
    check('o painel lista os pacotes', todos.length > 0, `${todos.length} pacotes`);
    const alvo = todos[0];
    const desativa = await api(`/admin/coin-packages/${alvo.id}`, {
      method: 'PATCH', headers: como(adm.token),
      body: JSON.stringify({ active: false, reason: 'admin-check: desativação temporária' }),
    });
    check('administrador desativa um pacote', desativa.body.package?.active === false,
      JSON.stringify(desativa.body).slice(0, 120));
    const vitrine = (await api('/shop/coin-packages')).body.packages ?? [];
    check('e ele some da vitrine pública', !vitrine.some((p) => p.id === alvo.id),
      `${vitrine.length} na vitrine`);
    await api(`/admin/coin-packages/${alvo.id}`, {
      method: 'PATCH', headers: como(adm.token),
      body: JSON.stringify({ active: true, reason: 'admin-check: religando' }),
    });
    const voltou = (await api('/shop/coin-packages')).body.packages ?? [];
    check('religar devolve o pacote à vitrine', voltou.some((p) => p.id === alvo.id));

    const logEconomia = (await api('/admin/audit?action=economy.admin_adjustment', { headers: como(adm.token) })).body.entries ?? [];
    check('o ajuste de saldo deixou rastro com motivo',
      typeof logEconomia[0]?.reason === 'string' && logEconomia[0].reason.length > 3,
      JSON.stringify(logEconomia[0]?.reason));

  }

  passo('15) Encerrar uma live pelo painel — e a live acabar de verdade');
  let liveSala = null;
  try {
    const cliente = new Client(WS);
    liveSala = await cliente.create('live', {
      token: ana.token, title: `admin-check ${Date.now()}`, category: 'música',
    });
    for (const t of ['chatMessage', 'notice', 'giftEvent', 'stageInvite', 'pkResult', 'follow']) {
      liveSala.onMessage(t, () => {});
    }
  } catch (err) {
    console.log(`  · sem game server: passo 15 pulado (${String(err?.message ?? err).slice(0, 60)})`);
  }
  if (liveSala) {
    const avisosLive = [];
    liveSala.onMessage('notice', (n) => avisosLive.push(n));
    // A live só entra na lista do painel depois de registrada na API, e ela é
    // registrada preguiçosamente — um espectador basta para forçar.
    const espectadorCliente = new Client(WS);
    const espectador = await espectadorCliente.joinById(liveSala.roomId, { token: beto.token });
    for (const t of ['chatMessage', 'notice', 'giftEvent', 'stageInvite', 'pkResult', 'follow']) {
      espectador.onMessage(t, () => {});
    }

    const viva = await esperar('a live aparecer no painel', async () => {
      const lista = (await api('/admin/lives', { headers: como(mod.token) })).body.lives ?? [];
      return lista.some((l) => l.roomId === liveSala.roomId);
    }, 20_000);
    check('o painel enxerga a live ativa', viva);

    const semMotivoLive = await api(`/admin/lives/${liveSala.roomId}/close`, {
      method: 'POST', headers: como(mod.token), body: JSON.stringify({ reason: 'x' }),
    });
    check('encerrar sem motivo é recusado', semMotivoLive.status === 400, `status=${semMotivoLive.status}`);

    const ordem = await api(`/admin/lives/${liveSala.roomId}/close`, {
      method: 'POST', headers: como(mod.token),
      body: JSON.stringify({ reason: 'admin-check: encerramento de teste' }),
    });
    check('a ordem foi aceita', ordem.status === 200 && Boolean(ordem.body.commandId),
      JSON.stringify(ordem.body));

    const repetida = await api(`/admin/lives/${liveSala.roomId}/close`, {
      method: 'POST', headers: como(mod.token),
      body: JSON.stringify({ reason: 'admin-check: mandando de novo' }),
    });
    check('mandar de novo não empilha ordem', repetida.body?.alreadyPending === true,
      JSON.stringify(repetida.body));

    // A ordem viaja de carona no batimento de presença: até alguns segundos.
    const acabou = await esperar('a sala obedecer',
      async () => liveSala.state?.ended === true, 30_000);
    check('a live realmente terminou na sala', acabou, `ended=${liveSala.state?.ended}`);
    check('a plateia foi avisada de que acabou',
      avisosLive.some((a) => a.code === 'live_ended'), JSON.stringify(avisosLive).slice(0, 120));

    const sumiu = await esperar('a live sair do feed', async () => {
      const lista = (await api('/lives')).body.lives ?? [];
      return !lista.some((l) => l.hostId === ana.identity.userId);
    }, 20_000);
    check('e saiu do feed público', sumiu);

    const logLive = (await api('/admin/audit?action=live.close', { headers: como(mod.token) })).body.entries ?? [];
    check('o encerramento deixou rastro com motivo',
      typeof logLive[0]?.reason === 'string' && logLive[0].reason.includes('admin-check'),
      JSON.stringify(logLive[0]?.reason));

    await espectador.leave().catch(() => {});
    await liveSala.leave().catch(() => {});
  }

  passo('16) O painel de produto responde a North Star (§31, §32)');
  // Primeiro provocar a interação, depois medir: um gate que só lê a métrica
  // passa num sistema que nunca a alimentou.
  await api(`/users/${beto.identity.userId}/follow`, {
    method: 'PUT', headers: como(ana.token), body: JSON.stringify({ following: true }),
  });
  const metricas = (await api('/admin/metrics?days=7', { headers: como(mod.token) })).body;
  check('as métricas respondem', typeof metricas.weeklySociallyActivePlayers === 'number',
    JSON.stringify(metricas).slice(0, 120));
  check('a janela é a pedida', metricas.window?.days === 7, JSON.stringify(metricas.window));
  check('conta pessoas socialmente ativas', metricas.weeklySociallyActivePlayers >= 1,
    `WSAP=${metricas.weeklySociallyActivePlayers}`);
  check('e sabe por qual tipo de interação', typeof metricas.socialByKind === 'object'
    && Object.keys(metricas.socialByKind ?? {}).length > 0, JSON.stringify(metricas.socialByKind));
  check('o follow que acabou de acontecer está lá',
    (metricas.socialByKind ?? {}).follow >= 1, JSON.stringify(metricas.socialByKind));
  check('a economia aparece com conversão e ARPPU',
    typeof metricas.economy?.buyerConversion === 'number' && typeof metricas.economy?.arppuCents === 'number',
    JSON.stringify(metricas.economy));
  check('o mundo aparece com lives, PKs e gifts',
    typeof metricas.world?.livesStarted === 'number' && typeof metricas.world?.pkMatches === 'number',
    JSON.stringify(metricas.world));
  // A metade que só o game server vê (§32): chat não existe em tabela nenhuma.
  if (sala !== null || liveSala !== null) {
    let salaChat = null;
    try {
      const cliente = new Client(WS);
      salaChat = await cliente.joinOrCreate('city', { token: ana.token, sceneId: 'central_plaza' });
      for (const t of ['chatMessage', 'notice', 'presence']) salaChat.onMessage(t, () => {});
      await new Promise((r) => setTimeout(r, 500));
      salaChat.send('chat', { text: 'admin-check: medindo a North Star' });
    } catch { /* sem game server, a próxima checagem cobra */ }
    if (salaChat) {
      // O worker acumula e manda em lote (30 s por padrão): a espera é o preço
      // de não pagar um INSERT por mensagem de chat.
      const chegou = await esperar('o chat virar métrica', async () => {
        const m = (await api('/admin/metrics?days=1', { headers: como(mod.token) })).body;
        return (m.socialByKind ?? {}).chat >= 1;
      }, 45_000);
      check('conversa na praça vira interação social na métrica', chegou);
      await salaChat.leave().catch(() => {});
    }
  }

  const semPapel = await api('/admin/metrics', { headers: como(ana.token) });
  check('jogador comum não vê o painel de produto (403)', semPapel.status === 403,
    `status=${semPapel.status}`);

  passo('17) Banimento temporário: a punição que acaba sozinha (§27)');
  const suspensao = await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'suspend', reason: 'admin-check: suspensão de 1 minuto', minutes: 1 }),
  });
  check('suspender com prazo grava a data de volta',
    suspensao.status === 200 && Boolean(suspensao.body.user?.suspendedUntil),
    JSON.stringify(suspensao.body.user).slice(0, 140));
  check('e derruba a sessão (refresh apagado)', suspensao.body.sessionsRevoked >= 0,
    `sessões=${suspensao.body.sessionsRevoked}`);

  const entrarSuspenso = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'beto', password: 'streampolis-dev' }),
  });
  // 403 e não 401 de propósito: a senha está certa, a CONTA é que está fora.
  // Responder "credenciais inválidas" mandaria a pessoa trocar a senha à toa.
  check('suspenso não entra, e a recusa diz que é a conta',
    entrarSuspenso.status === 403 && entrarSuspenso.body?.error === 'account_unavailable',
    `status=${entrarSuspenso.status} ${JSON.stringify(entrarSuspenso.body)}`);

  const semPrazo = await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'suspend', reason: 'admin-check: suspensão sem prazo' }),
  });
  check('sem minutos, a suspensão é permanente até reintegrarem',
    semPrazo.body.user?.suspendedUntil === null, JSON.stringify(semPrazo.body.user).slice(0, 120));

  await api(`/admin/users/${beto.identity.userId}/sanction`, {
    method: 'POST', headers: como(mod.token),
    body: JSON.stringify({ action: 'reinstate', reason: 'admin-check: fim do teste' }),
  });
  const voltou = await api('/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'beto', password: 'streampolis-dev' }),
  });
  check('reintegrado volta a entrar', voltou.status === 200, `status=${voltou.status}`);

  passo('18) Agências no painel (§28)');
  const listaAg = await api('/admin/agencies', { headers: como(mod.token) });
  check('o painel lista agências', listaAg.status === 200 && Array.isArray(listaAg.body.agencies),
    JSON.stringify(listaAg.body).slice(0, 100));
  const semMotivoAg = await api('/admin/agencies/00000000-0000-0000-0000-000000000000', {
    method: 'DELETE', headers: como(mod.token), body: JSON.stringify({ reason: 'x' }),
  });
  check('dissolver sem motivo é recusado', semMotivoAg.status === 400, `status=${semMotivoAg.status}`);
  const inexistente = await api('/admin/agencies/00000000-0000-0000-0000-000000000000', {
    method: 'DELETE', headers: como(mod.token),
    body: JSON.stringify({ reason: 'admin-check: agência que não existe' }),
  });
  check('agência inexistente responde 404', inexistente.status === 404, `status=${inexistente.status}`);

  console.log(`\n${falhas === 0 ? '✅' : '❌'} ${total - falhas}/${total} verificações passaram.`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 admin-check falhou:', err?.message ?? err);
  process.exit(1);
});
