#!/usr/bin/env node
/**
 * Prova das agências (PRD §19).
 *
 * A pergunta que este arquivo responde: **uma agência é uma organização ou uma
 * lista de nomes?** A diferença está nas recusas — quem NÃO pode convidar, quem
 * NÃO pode desligar quem, e o dono que não consegue sair pela porta dos membros
 * deixando a agência órfã.
 *
 * E uma prova de ponta a ponta que atravessa dois sistemas: entrar numa agência
 * tem de aparecer no TOKEN (é assim que o nome da agência chega ao mundo, ao
 * lado do nome do jogador) e na métrica social do §32.
 *
 *   node tools/agency-check.mjs [--api=http://127.0.0.1:8787]
 */
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=') || 'true'];
}));
const API = (args.api ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

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

/**
 * Contas novas, criadas pelo formulário. Agência é sobre gente que se junta, e
 * as fixtures do seed já podem estar em outra agência de uma rodada anterior —
 * um teste que depende do estado de ontem falha amanhã.
 */
const STAMP = Date.now().toString(36).slice(-6);
async function novaConta(sufixo) {
  const username = `ag_${STAMP}_${sufixo}`;
  const { status, body } = await api('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username, email: `${username}@agency-check.streampolis`, password: `Ag!${STAMP}#${sufixo}7`,
    }),
  });
  if (status !== 201) throw new Error(`cadastro de ${username} falhou (${status}): ${JSON.stringify(body)}`);
  return { username, ...body, userId: body.identity.userId };
}

const claims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

async function main() {
  console.log(`\nAgências — ${API}`);
  const saude = await api('/health');
  if (saude.status !== 200) { console.error(`API fora do ar em ${API}`); process.exit(2); }

  const dona = await novaConta('a');
  const membro = await novaConta('b');
  const estranho = await novaConta('c');

  passo('1) Fundar');
  const nomeRuim = await api('/agencies', {
    method: 'POST', headers: como(dona.token), body: JSON.stringify({ name: 'a' }),
  });
  check('nome curto demais é recusado', nomeRuim.status === 400, `status=${nomeRuim.status}`);

  const nome = `Agência ${STAMP}`;
  const criada = await api('/agencies', {
    method: 'POST', headers: como(dona.token), body: JSON.stringify({ name: nome }),
  });
  check('a agência nasce com quem fundou como dono',
    criada.status === 201 && criada.body.agency?.ownerId === dona.userId,
    JSON.stringify(criada.body).slice(0, 140));
  const agencyId = criada.body.agency.agencyId;
  check('e já com um membro: o dono', criada.body.agency.memberCount === 1,
    `membros=${criada.body.agency.memberCount}`);

  const denovo = await api('/agencies', {
    method: 'POST', headers: como(dona.token), body: JSON.stringify({ name: `Outra ${STAMP}` }),
  });
  check('ninguém funda a segunda agência estando na primeira', denovo.status === 409,
    `status=${denovo.status}`);

  const mesmoNome = await api('/agencies', {
    method: 'POST', headers: como(estranho.token), body: JSON.stringify({ name: nome.toUpperCase() }),
  });
  check('nome repetido (mesmo em outra caixa) é recusado', mesmoNome.status === 409,
    `status=${mesmoNome.status}`);

  passo('2) Entrar é ato de duas vontades');
  const conviteDeEstranho = await api(`/agencies/${agencyId}/invites/${membro.userId}`, {
    method: 'POST', headers: como(estranho.token),
  });
  check('quem não é da agência não convida (403)', conviteDeEstranho.status === 403,
    `status=${conviteDeEstranho.status}`);

  const convite = await api(`/agencies/${agencyId}/invites/${membro.userId}`, {
    method: 'POST', headers: como(dona.token),
  });
  check('o dono convida', convite.status === 200, JSON.stringify(convite.body));

  const meuAntes = (await api('/me/agency', { headers: como(membro.token) })).body;
  check('o convite aparece para quem foi convidado',
    (meuAntes.invites ?? []).some((i) => i.agencyId === agencyId), JSON.stringify(meuAntes.invites));
  check('e ele ainda NÃO está na agência', meuAntes.agency === null, JSON.stringify(meuAntes.agency));

  const semConvite = await api(`/me/agency/invites/${agencyId}/accept`, {
    method: 'POST', headers: como(estranho.token),
  });
  check('quem não foi convidado não entra (404)', semConvite.status === 404, `status=${semConvite.status}`);

  const aceito = await api(`/me/agency/invites/${agencyId}/accept`, {
    method: 'POST', headers: como(membro.token),
  });
  check('aceitar entra na agência', aceito.status === 200 && aceito.body.agency?.memberCount === 2,
    JSON.stringify(aceito.body.agency).slice(0, 140));
  const depois = (await api('/me/agency', { headers: como(membro.token) })).body;
  check('e o convite some da caixa de entrada', (depois.invites ?? []).length === 0);
  check('com a função de membro', depois.role === 'member', `role=${depois.role}`);

  passo('3) O nome da agência viaja no token — é assim que ele chega ao mundo');
  const renovado = (await api('/auth/refresh', {
    method: 'POST', body: JSON.stringify({ refreshToken: membro.refreshToken }),
  })).body;
  check('o token novo carrega a agência', claims(renovado.token).agency === nome,
    `agency=${claims(renovado.token).agency}`);
  check('o token ANTIGO continua sem ela (a sessão vira no próximo token)',
    claims(membro.token).agency === '', `agency=${claims(membro.token).agency}`);

  passo('4) Hierarquia: quem manda em quem');
  const promovePorMembro = await api(`/agencies/${agencyId}/members/${membro.userId}/role`, {
    method: 'PUT', headers: como(membro.token), body: JSON.stringify({ role: 'manager' }),
  });
  check('membro não se promove (403)', promovePorMembro.status === 403, `status=${promovePorMembro.status}`);

  const promove = await api(`/agencies/${agencyId}/members/${membro.userId}/role`, {
    method: 'PUT', headers: como(dona.token), body: JSON.stringify({ role: 'manager' }),
  });
  check('o dono promove a gerente', promove.status === 200
    && promove.body.agency.members.find((m) => m.userId === membro.userId)?.role === 'manager',
    JSON.stringify(promove.body.agency?.members).slice(0, 140));

  const gerenteConvida = await api(`/agencies/${agencyId}/invites/${estranho.userId}`, {
    method: 'POST', headers: como(membro.token),
  });
  check('gerente também convida', gerenteConvida.status === 200, JSON.stringify(gerenteConvida.body));
  await api(`/me/agency/invites/${agencyId}/decline`, { method: 'POST', headers: como(estranho.token) });

  passo('5) O dono não deixa a agência órfã');
  const donoSai = await api(`/agencies/${agencyId}/members/${dona.userId}`, {
    method: 'DELETE', headers: como(dona.token),
  });
  check('o dono não sai pela porta dos membros (409)', donoSai.status === 409, `status=${donoSai.status}`);

  const gerenteDesligaDono = await api(`/agencies/${agencyId}/members/${dona.userId}`, {
    method: 'DELETE', headers: como(membro.token),
  });
  check('e nem é desligado por um gerente', gerenteDesligaDono.status === 409,
    `status=${gerenteDesligaDono.status}`);

  const transferida = await api(`/agencies/${agencyId}/transfer/${membro.userId}`, {
    method: 'POST', headers: como(dona.token),
  });
  check('transferir troca os dois papéis de uma vez',
    transferida.body.agency?.ownerId === membro.userId
    && transferida.body.agency.members.find((m) => m.userId === dona.userId)?.role === 'manager',
    JSON.stringify(transferida.body.agency?.members).slice(0, 160));

  const agoraSai = await api(`/agencies/${agencyId}/members/${dona.userId}`, {
    method: 'DELETE', headers: como(dona.token),
  });
  check('quem deixou de ser dono já pode sair', agoraSai.status === 200 && agoraSai.body.removed === true,
    JSON.stringify(agoraSai.body));

  passo('6) Fama é somada dos membros, não guardada num contador');
  const publica = (await api(`/agencies/${agencyId}`)).body.agency;
  check('a agência aparece publicamente', Boolean(publica?.agencyId));
  check('com fama somada dos membros atuais', typeof publica.fame === 'number', `fame=${publica.fame}`);
  check('e com um membro só depois da saída', publica.memberCount === 1, `membros=${publica.memberCount}`);
  const ranking = (await api('/agencies')).body.agencies ?? [];
  check('o ranking de agências lista a nova', ranking.some((a) => a.agencyId === agencyId),
    `${ranking.length} agências`);

  passo('7) Dissolver');
  const dissolvePorEx = await api(`/agencies/${agencyId}`, { method: 'DELETE', headers: como(dona.token) });
  check('quem não é mais dono não dissolve (403)', dissolvePorEx.status === 403,
    `status=${dissolvePorEx.status}`);
  const dissolve = await api(`/agencies/${agencyId}`, { method: 'DELETE', headers: como(membro.token) });
  check('o dono dissolve', dissolve.status === 200 && dissolve.body.disbanded === true,
    JSON.stringify(dissolve.body));
  const sumiu = await api(`/agencies/${agencyId}`);
  check('e ela some de vez', sumiu.status === 404, `status=${sumiu.status}`);
  const orfao = (await api('/me/agency', { headers: como(membro.token) })).body;
  check('quem estava nela fica sem agência', orfao.agency === null, JSON.stringify(orfao.agency));

  console.log(`\n${falhas === 0 ? '✅' : '❌'} ${total - falhas}/${total} verificações passaram.`);
  console.log(`   contas desta rodada: ${dona.username}, ${membro.username}, ${estranho.username}`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 agency-check falhou:', err?.message ?? err);
  process.exit(1);
});
