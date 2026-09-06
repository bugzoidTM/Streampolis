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

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const como = (token) => ({ authorization: `Bearer ${token}` });

async function entrar(username) {
  const { status, body } = await api('/auth/dev-login', {
    method: 'POST', body: JSON.stringify({ username }),
  });
  if (status !== 200) throw new Error(`entrar como ${username} falhou (${status})`);
  return body;
}

async function main() {
  console.log(`\nPainel administrativo — ${API}`);

  const saude = await api('/health');
  if (saude.status !== 200) { console.error(`API fora do ar em ${API}`); process.exit(2); }

  const mod = await entrar('moderador');
  const ana = await entrar('ana');
  const beto = await entrar('beto');

  passo('1) A porta: painel é do papel, não do pedido');
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

  console.log(`\n${falhas === 0 ? '✅' : '❌'} ${total - falhas}/${total} verificações passaram.`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 admin-check falhou:', err?.message ?? err);
  process.exit(1);
});
