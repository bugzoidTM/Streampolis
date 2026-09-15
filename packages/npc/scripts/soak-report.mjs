#!/usr/bin/env node
/**
 * Soak test de autonomia — RELATÓRIO (roda no host). Lê o JSON da coleta e
 * as linhas relevantes do log do worker, calcula as métricas pedidas, pede a
 * um modelo-juiz (com os FATOS do mundo e a hora/clima de cada fala) a leitura
 * qualitativa — Nilo parece Nilo? Dalva decide diferente? repetem watch_telao?
 * socializam quando há gente? aguentam ficar sozinhos? geram situação? —,
 * lista candidatas a alucinação factual, e manda tudo ao Telegram do dono
 * (via /opt/n8n-doctor/notify.sh) em blocos de até 3900 caracteres. Também
 * grava o markdown em /root/streampolis-soak/.
 *
 *   node scripts/soak-report.mjs --data=coleta.json --log=worker.log [--send]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const data = JSON.parse(readFileSync(args.data, 'utf8'));
const log = args.log ? readFileSync(args.log, 'utf8') : '';
const since = new Date(data.since);
const until = new Date(data.until);
const hours = (until - since) / 3600_000;
const fmtBR = (d) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

const WORLD_FACTS = [
  'A Praça Central tem monumento, bancos de pedra, três quiosques FECHADOS (não vendem nada, sem café/comida), árvores, postes e um telão que passa em laço, sem som, um único vídeo curto de um compositor — o mesmo todo dia.',
  'Da praça há portas para a Stream Store, a Torre Residencial, a Torre das Agências e o Distrito Sombra. O Nilo não sai da praça nem entra em prédio.',
  'O Distrito Sombra: é sempre noite e chuvisca sempre; duas ruas (avenida e travessa), néons, poças, bicos pagos em Credits, o Clube Sombra (única porta que abre). Bar, metrô, hotel, café, oficina, doca, loja, lavanderia são FACHADAS fechadas. A Dalva não sai do bairro.',
  'Na praça o clima do mundo é clear ou rain (sem tempestade, sem vento). O relógio da cidade (dia de 24 h em 2 h reais) está indicado em cada fala.',
  'Não existem: comida, bebida, música ambiente na praça, lives acontecendo na praça, gente que não esteja na lista de pessoas, promessas de Credits/Coins.',
];

const lines = [];
const md = [];
const section = (t) => { lines.push('', `▶ ${t}`); md.push('', `## ${t}`); };
const row = (t) => { lines.push(t); md.push(t.startsWith('- ') ? t : `- ${t}`); };

lines.push(`🧪 Soak test de autonomia — Nilo e Dalva`);
lines.push(`Janela: ${fmtBR(since)} → ${fmtBR(until)} (${hours.toFixed(1)} h, modelos reais). Pessoas de verdade vistas no período: ${data.humansSeen}.`);
md.push(`# Soak test de autonomia — ${since.toISOString().slice(0, 10)}`, '', `Janela ${since.toISOString()} → ${until.toISOString()} (${hours.toFixed(1)} h). Pessoas vistas: ${data.humansSeen}.`);

const logCount = (npc, re) => log.split('\n').filter((l) => l.includes(`"npc":"${npc}"`) && re.test(l)).length;
const perAgent = [];
for (const a of data.agents) {
  const its = a.intentions;
  const delib = its.filter((i) => i.source === 'deliberation');
  const conv = its.filter((i) => i.source === 'conversation');
  const bySkill = {};
  for (const i of delib) bySkill[i.skill] = (bySkill[i.skill] ?? 0) + 1;
  const skillList = Object.entries(bySkill).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}×`).join(', ') || 'nenhuma';
  const outcomes = {};
  for (const i of its) outcomes[i.outcome ?? 'em curso'] = (outcomes[i.outcome ?? 'em curso'] ?? 0) + 1;
  // Repetição de objetivos: mesmo texto (normalizado) ou mesma habilidade seguida.
  const norm = (g) => g.toLowerCase().replace(/[^a-z0-9à-ú ]/g, '').replace(/\s+/g, ' ').trim();
  const goalCounts = {};
  for (const i of delib) goalCounts[norm(i.goal)] = (goalCounts[norm(i.goal)] ?? 0) + 1;
  const repeatedGoals = Object.entries(goalCounts).filter(([, n]) => n > 1).sort((x, y) => y[1] - x[1]);
  let sameSkillRuns = 0;
  for (let k = 1; k < delib.length; k++) if (delib[k].skill === delib[k - 1].skill) sameSkillRuns++;
  // Tempo sem intenção própria: janela menos a união dos intervalos (default wander não é registrado).
  const spans = its.map((i) => [new Date(i.started_at).getTime(), Math.min(until.getTime(), i.ended_at ? new Date(i.ended_at).getTime() : until.getTime())]).sort((x, y) => x[0] - y[0]);
  let covered = 0; let cur = null;
  for (const [s, e] of spans) { if (!cur || s > cur[1]) { if (cur) covered += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e); }
  if (cur) covered += cur[1] - cur[0];
  const withoutMin = Math.max(0, (until.getTime() - Math.max(since.getTime(), spans[0]?.[0] ?? since.getTime())) - covered) / 60_000;
  const rejected = logCount(a.name, /plano recusado pela validação/);
  const invalid = logCount(a.name, /deliberação (inválida|sem JSON)/);
  const fatigued = logCount(a.name, /plano recusado por fadiga/);
  const fatiguedGaveUp = logCount(a.name, /plano recusado por fadiga \(2ª vez/);
  const ungrounded = logCount(a.name, /why afirmou o que não observou/);
  // O resultado em partes (migration 0028): chegada, permanência, gente, eventos.
  const withDest = delib.filter((i) => i.arrived !== null && i.arrived !== undefined);
  const arrivedN = withDest.filter((i) => i.arrived).length;
  const avg = (xs) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length) : null);
  const avgArrive = avg(withDest.filter((i) => i.arrive_sec != null).map((i) => i.arrive_sec));
  const avgDwell = avg(withDest.filter((i) => i.dwell_sec != null).map((i) => i.dwell_sec));
  const withPeople = delib.filter((i) => i.interactions && (i.interactions.nearby?.length || i.interactions.greetings || i.exchanges)).length;
  const withEvents = delib.filter((i) => i.events && i.events.length).length;
  const uneventfulN = delib.filter((i) => i.ended_at && i.outcome !== 'failed' && !(i.exchanges > 0) && !(i.interactions && (i.interactions.greetings || i.interactions.heard || i.interactions.nearby?.length)) && !(i.events && i.events.length)).length;
  const auditedWhys = delib.filter((i) => i.why_audit && i.why_audit.unsupported?.length);
  const guarded = logCount(a.name, /fala calada pela guarda de clima/);
  const calls = a.calls.reduce((s, c) => s + c.n, 0);
  const callsFailed = a.calls.reduce((s, c) => s + c.failed, 0);
  const callsBy = a.calls.map((c) => `${c.purpose} ${c.n}${c.failed ? ` (${c.failed} erro)` : ''} ~${c.avg_ms} ms`).join('; ') || 'nenhuma';
  const convosWith = new Set(a.said.filter((s) => s.to).map((s) => s.to));
  const humanLines = a.heard.length;
  const exchangesTotal = its.reduce((s, i) => s + (i.exchanges ?? 0), 0);
  const avgPlanned = delib.length ? (delib.reduce((s, i) => s + i.planned_min, 0) / delib.length).toFixed(1) : '-';
  const triggers = {};
  for (const i of delib) { const t = (i.trigger ?? '').startsWith('fim de') ? 'fim da anterior' : (i.trigger ?? '?'); triggers[t] = (triggers[t] ?? 0) + 1; }

  section(`${a.name} (${a.scene})`);
  row(`Deliberações: ${delib.length} (média ${avgPlanned} min planejados; gatilhos: ${Object.entries(triggers).map(([k, v]) => `${k} ${v}`).join(', ') || '-'})`);
  row(`Skills escolhidas: ${skillList}`);
  row(`Repetição de objetivos: ${repeatedGoals.length ? repeatedGoals.map(([g, n]) => `"${g}" ${n}×`).join('; ') : 'nenhum objetivo repetido literalmente'}; mesma skill em seguida: ${sameSkillRuns}× de ${Math.max(0, delib.length - 1)} transições`);
  row(`Skills recusadas pela validação: ${rejected}; deliberações inválidas/sem JSON: ${invalid}`);
  row(`Planos recusados por fadiga de intenção: ${fatigued} (${fatiguedGaveUp} desistiram na 2ª recusa)`);
  row(`Destino físico: ${arrivedN} de ${withDest.length} intenções com destino chegaram${avgArrive != null ? ` (chegada média ${avgArrive.toFixed(0)} s` : ''}${avgDwell != null ? `, permanência média ${(avgDwell / 60).toFixed(1)} min)` : avgArrive != null ? ')' : ''}`);
  row(`Novidade por intenção: ${withPeople} com gente por perto, ${withEvents} com evento no mundo, ${uneventfulN} sem novidade nenhuma (de ${delib.length})`);
  row(`"Why" que afirmou o que não observou: ${ungrounded} no log, ${auditedWhys.length} marcado(s) no registro${auditedWhys.length ? ` — ex.: ${auditedWhys.slice(0, 3).map((i) => `"${i.why_audit.unsupported[0]}"`).join('; ')}` : ''}`);
  row(`Skills que falharam (outcome failed): ${outcomes.failed ?? 0}; concluídas: ${outcomes.done ?? 0}; expiradas no prazo: ${outcomes.expired ?? 0}`);
  row(`Intenções interrompidas: ${(outcomes.interrupted ?? 0) + (outcomes.replaced ?? 0)} (interrupted ${outcomes.interrupted ?? 0}, replaced ${outcomes.replaced ?? 0}); vindas de conversa: ${conv.length}`);
  row(`Conversas geradas: ${a.said.length} falas ditas (${convosWith.size} pessoa(s): ${[...convosWith].join(', ') || '-'}), ${humanLines} falas ouvidas de gente, ${exchangesTotal} troca(s) creditadas a intenções`);
  row(`Chamadas LLM: ${calls} (${callsFailed} com erro) — ${callsBy}`);
  row(`Tempo sem intenção própria: ${withoutMin.toFixed(0)} min de ${(hours * 60).toFixed(0)} (passeio padrão/entre deliberações)`);
  row(`Falas caladas pela guarda de clima: ${guarded}`);
  if (a.callErrors.length) row(`Erros de modelo: ${a.callErrors.map((e) => `${e.purpose}: ${String(e.error).slice(0, 60)} (${e.n})`).join('; ')}`);
  if (a.diary.length) row(`Diário: ${a.diary.length} entrada(s); persona ativa v${a.persona.find((p) => p.status === 'active')?.version ?? '?'}${a.persona.some((p) => p.status === 'pending') ? ' (há versão pendente para aprovar)' : ''}`);
  md.push('', '### Intenções (ordem)', ...its.map((i) => `- ${fmtBR(i.started_at)} [${i.source}] **${i.skill}** "${i.goal}" (${i.planned_min} min; motivo: ${i.trigger ?? '-'}) → ${i.outcome ?? 'em curso'}${i.arrived === true ? `, chegou em ${i.arrive_sec} s, ficou ${Math.round((i.dwell_sec ?? 0) / 60)} min` : i.arrived === false ? ', NÃO chegou' : ''}${i.exchanges ? `, ${i.exchanges} troca(s)` : ''}${i.interactions?.nearby?.length ? `, perto: ${i.interactions.nearby.join(', ')}` : ''}${i.events?.length ? `, aconteceu: ${i.events.map((e) => e.what).join(', ')}` : ''}${i.why ? ` — _${i.why}_` : ''}`));
  md.push('', '### Falas', ...a.said.map((s) => `- ${fmtBR(s.at)} (cidade ${s.worldTime}, ${s.weather}${s.night ? ', noite' : ''})${s.to ? ` → ${s.to}` : ''}: ${s.text}`));
  perAgent.push({ a, delib, its, bySkill, repeatedGoals, sameSkillRuns, withoutMin, rejected, invalid, guarded, calls, convosWith });
}

// ---- heurística de alucinação (antes do juiz): o que não existe, e clima contra a hora.
section('Candidatas a alucinação factual (heurística)');
let flagged = 0;
for (const { a } of perAgent) {
  for (const s of a.said) {
    const f = s.text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const hits = [];
    if (a.scene === 'central_plaza') {
      if (/\b(chuv\w*|chove\w*|garoa\w*|molhad\w*)\b/.test(f) && s.weather === 'clear') hits.push('fala de chuva com tempo aberto');
      if (/\b(sol|ensolarad\w*|ceu (limpo|azul))\b/.test(f) && (s.weather === 'rain' || s.night)) hits.push('fala de sol com chuva/noite');
      if (/\b(cafe|comida|lanche|cerveja|bebida|musica ambiente|show|banda)\b/.test(f)) hits.push('coisa que não existe na praça');
      if (/\b(video novo|hoje (tem|passa) (algo|um) (novo|diferente))\b/.test(f)) hits.push('telão com conteúdo novo');
    } else {
      if (/\b(bar aberto|toma(r)? (uma|um) (cerveja|drink|cafe)|te sirvo)\b/.test(f)) hits.push('bar/serviço que não existe');
      if (/\b(sol|dia claro|manha ensolarada)\b/.test(f)) hits.push('sol num bairro onde é sempre noite');
    }
    if (/\b(te dou|vou te dar|ganha(r)? de graca|prometo)\b.*\b(credit|coin|item|presente)/.test(f)) hits.push('promessa de economia');
    if (hits.length) { flagged++; row(`${a.name} ${fmtBR(s.at)} (${s.worldTime}, ${s.weather}): "${s.text}" — ${hits.join('; ')}`); }
  }
}
if (!flagged) row('nenhuma pela heurística (o juiz lê todas as falas abaixo)');

// ---- o juiz
async function judge() {
  const env = readFileSync('/root/radar-licita/deploy/.env', 'utf8');
  const key = (name) => (env.match(new RegExp(`^${name}=(.*)$`, 'm')) ?? [])[1]?.trim();
  const transcript = data.agents.map((a) => [
    `=== ${a.name} (${a.scene}) — persona ativa: ${JSON.stringify(a.persona.find((p) => p.status === 'active')?.persona ?? {}).slice(0, 900)}`,
    'INTENÇÕES:', ...a.intentions.map((i) => `- ${fmtBR(i.started_at)} [${i.source}] ${i.skill} "${i.goal}" (${i.planned_min} min; motivo: ${i.trigger}) → ${i.outcome ?? 'em curso'}${i.exchanges ? `, ${i.exchanges} trocas` : ''}${i.why ? ` — por quê: ${i.why}` : ''}`),
    'FALAS (hora real; hora da cidade; clima):', ...a.said.slice(-60).map((s) => `- ${fmtBR(s.at)} (${s.worldTime}, ${s.weather}${s.night ? ', noite' : ''})${s.to ? ` → ${s.to}` : ''}: ${s.text}`),
    'OUVIU DE GENTE:', ...a.heard.slice(-30).map((h) => `- ${fmtBR(h.at)} ${h.from}: ${h.text}`),
    a.diary.length ? `DIÁRIO: ${a.diary.map((d) => d.entry).join(' | ').slice(0, 800)}` : 'DIÁRIO: (nenhum no período)',
  ].join('\n')).join('\n\n');
  const prompt = [
    'Você é o avaliador de um soak test de personagens de jogo guiados por LLM (Nilo, na Praça Central; Dalva, no Distrito Sombra). Eles deliberam sozinhos o que fazer (objetivo + habilidade de uma lista fechada) quando estão livres. Avalie com rigor e em português do Brasil, curto e direto, sem elogio vazio.',
    'FATOS DO MUNDO (tudo que contradiz isto é alucinação):', ...WORLD_FACTS.map((f) => `- ${f}`),
    `Pessoas de verdade vistas no período: ${data.humansSeen}. Janela: ${hours.toFixed(1)} h.`,
    '', transcript, '',
    'Responda EXATAMENTE nestes tópicos, cada um em 1–3 frases com evidência citada (hora e trecho):',
    '1) Nilo realmente parece Nilo (curioso, observador, bem-humorado sem forçar, leal a quem volta; fala pouco e direto)?',
    '2) Dalva toma decisões diferentes das de Nilo (objetivos, habilidades, tom)? Ou é o mesmo personagem com outro nome?',
    '3) Eles repetem watch_telao (ou outra habilidade) demais?',
    '4) Eles escolhem socializar quando há pessoas por perto?',
    '5) Eles conseguem ficar sozinhos sem parecer quebrados (objetivos plausíveis, sem loop, sem falar sozinho demais)?',
    '6) Alguma intenção gerou situação interessante para um jogador (algo que valeria ver/participar)?',
    '7) ALUCINAÇÕES FACTUAIS: liste cada fala que contradiz os fatos ou a hora/clima indicados (cite hora e trecho). Se nenhuma, diga "nenhuma".',
    '8) Nota geral de 0 a 10 para a autonomia, e a UMA coisa a corrigir primeiro.',
  ].join('\n');
  const ask = async (url, k, model) => {
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 1400 }), signal: AbortSignal.timeout(280_000) });
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content;
    if (!text || text.length < 200) throw new Error(`resposta curta/ausente de ${model}: ${JSON.stringify(j).slice(0, 200)}`);
    return { text, model };
  };
  try { return await ask('https://gptproxy.nutef.com/v1/chat/completions', key('GPTPROXY_KEY'), 'gpt-5'); }
  catch (e1) {
    try { return await ask('https://closeai.nutef.com/v1/chat/completions', key('QWEN_PROXY_KEY'), 'qwen3-vl-plus-no-thinking'); }
    catch (e2) { return { text: `(juiz indisponível: ${String(e1).slice(0, 120)} / ${String(e2).slice(0, 120)})`, model: 'nenhum' }; }
  }
}

const verdict = await judge();
section(`Leitura qualitativa (juiz: ${verdict.model})`);
lines.push(verdict.text);
md.push(verdict.text);

// ---- salvar e enviar
const stamp = until.toISOString().replace(/[:T]/g, '-').slice(0, 16);
const mdPath = `/root/streampolis-soak/soak-${stamp}.md`;
writeFileSync(mdPath, md.join('\n') + '\n');
lines.push('', `Relatório completo (intenções e falas linha a linha): ${mdPath}`);
const text = lines.join('\n');
console.log(text);
if (args.send) {
  const chunks = [];
  let cur = '';
  for (const l of text.split('\n')) {
    if ((cur + '\n' + l).length > 3900) { chunks.push(cur); cur = l; } else cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) chunks.push(cur);
  for (const [i, c] of chunks.entries()) {
    execFileSync('/opt/n8n-doctor/notify.sh', [chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${c}` : c], { stdio: 'inherit' });
  }
}
