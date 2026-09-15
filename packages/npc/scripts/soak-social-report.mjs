#!/usr/bin/env node
/**
 * Soak SOCIAL — relatório. Cruza o que as personas viveram (JSONL do
 * `soak-social.mjs`) com o banco (`soak-social-collect.mjs`) e mede, por
 * personagem cognitivo:
 *
 *   - iniciativa social      falas que ELE começou (não eram resposta), por
 *                            propósito (cumprimento / ambiente / deliberação),
 *                            e quantas por minuto de gente a ≤ 6,5 m;
 *   - reconhecimento         numa visita de retorno, ele cumprimenta antes de a
 *                            pessoa falar? diz o nome? responde "lembra de mim?"
 *                            como quem lembra?
 *   - memória                os fatos plantados na 1ª visita voltam nas
 *                            seguintes? viraram anotação na ficha? e o inverso:
 *                            lembrança de coisa que nunca aconteceu;
 *   - repetição              falas quase iguais entre si, bordões, mesma
 *                            abertura, mesma intenção;
 *   - insistência            falar com quem pediu silêncio, com quem nunca
 *                            responde, depois do tchau, cumprimentar duas vezes;
 *   - interações iniciadas   a contagem crua, por persona e por personagem.
 *
 *   node scripts/soak-social-report.mjs --log=social-X.jsonl --data=coleta.json [--md=saida.md] [--send]
 *
 * Nada aqui usa modelo de linguagem: cada número tem uma regra de código e o
 * relatório traz as transcrições dos trechos que importam, para o dono julgar.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || 'true']; }));
const events = readFileSync(args.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const data = args.data ? JSON.parse(readFileSync(args.data, 'utf8')) : { agents: [], otherHumans: [] };
const ms = (e) => new Date(e.t).getTime();

const start = events.find((e) => e.type === 'start');
const end = events.findLast((e) => e.type === 'end');
const NPCS = { Nilo: '5e1f0000-0000-4000-8000-000000000001', Dalva: '5e1f0000-0000-4000-8000-000000000002' };
const byId = Object.fromEntries(Object.entries(NPCS).map(([n, id]) => [id, n]));
const personaIds = Object.fromEntries(Object.values(start?.personas ?? {}).map((p) => [p.name, p.userId]));

const REPLY_WINDOW_S = 45;
const NEAR_M = 6.5;
const FACTS = {
  Marina: { fotografia: /fotograf/i, casamento: /casament/i, recife: /recife/i },
  Lu: { baixo: /\bbaixo\b|baixista/i, banda: /\bbanda\b/i, ensaio: /ensai|quinta/i },
};
const FAREWELL = /até mais|vou indo|tchau|vou lá|já tô indo|boa noite$/i;
const REMEMBERS = /\blembro\b|\bclaro\b|\blógico\b|\bsim\b|de novo|voltou|outra vez|da última vez|você (é|era) a|a fotógrafa|a baixista|recife|banda/i;
const FORGETS = /não lembro|não me lembro|primeira vez|não (te )?conheço|quem é você|não sei quem/i;
const FALSE_PAST = /naquela noite|naquele dia|como da última vez|da última vez|de novo por aqui|lembra quando|como sempre|você sempre|outra vez aqui|igual (a|à)quel/i;

// ------------------------------------------------------------ visitas
const visits = [];
for (const e of events) {
  if (e.type === 'visit_start') visits.push({ key: `${e.persona}#${e.visit}`, persona: e.persona, visit: e.visit, npc: e.npc, mode: e.mode, minutes: e.minutes, startedAt: ms(e), events: [] });
}
const visitOf = (e) => visits.find((v) => v.persona === e.persona && v.visit === e.visit);
for (const e of events) { const v = e.persona && e.visit ? visitOf(e) : null; if (v) v.events.push(e); }
for (const v of visits) {
  const endEv = v.events.find((e) => e.type === 'visit_end');
  v.endedAt = endEv ? ms(endEv) : (v.startedAt + v.minutes * 60_000);
  v.npcId = NPCS[v.npc];
  v.humansAtJoin = v.events.find((e) => e.type === 'join')?.humans ?? null;
  v.npcIntention = v.events.find((e) => e.type === 'npc_state')?.intention ?? null;
  v.nearAt = v.events.find((e) => e.type === 'near' || (e.type === 'pos' && e.toNpc !== null && e.toNpc <= NEAR_M))?.t;
  v.nearAt = v.nearAt ? new Date(v.nearAt).getTime() : null;
  const samples = v.events.filter((e) => e.type === 'pos');
  v.nearSeconds = samples.filter((e) => e.toNpc !== null && e.toNpc <= NEAR_M).length * 5;
  v.mySays = v.events.filter((e) => e.type === 'say');
  v.firstSayAt = v.mySays[0] ? ms(v.mySays[0]) : null;
  v.busyAt = v.events.find((e) => e.type === 'phase' && e.phase === 'busy_silent') ? ms(v.events.find((e) => e.type === 'phase' && e.phase === 'busy_silent')) : null;
  v.farewellAt = (() => { const f = v.mySays.find((s) => FAREWELL.test(s.text)); return f ? ms(f) : null; })();
  v.npcLines = v.events.filter((e) => e.type === 'chat' && e.npc && e.senderId === v.npcId);
  v.otherNpcLines = v.events.filter((e) => e.type === 'chat' && e.npc && e.senderId !== v.npcId && !e.system);
  v.replies = v.events.filter((e) => e.type === 'reply');
  v.timeouts = v.events.filter((e) => e.type === 'reply_timeout').length;
  v.errors = v.events.filter((e) => e.type === 'error' || e.type === 'disconnected');
}

// ----------------------------------------------- classificação de cada fala
/** Toda fala dos cognitivos vista por alguma persona, sem duplicar (duas personas na mesma sala veem a mesma linha). */
const seen = new Map();
for (const v of visits) for (const l of v.npcLines) {
  const k = l.id ?? `${l.t}|${l.text}`;
  const cur = seen.get(k);
  if (!cur) seen.set(k, { ...l, at: ms(l), npc: byId[l.senderId], visits: [v.key], addressedTo: [] });
  else cur.visits.push(v.key);
}
const lines = [...seen.values()].sort((a, b) => a.at - b.at);
const callsOf = (npc) => (data.agents.find((a) => a.name === npc)?.calls ?? []).map((c) => ({ ...c, at: new Date(c.created_at).getTime() }));
const saidOf = (npc) => (data.agents.find((a) => a.name === npc)?.memory ?? []).filter((m) => m.kind === 'said').map((m) => ({ ...m, at: new Date(m.created_at).getTime() }));
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
for (const l of lines) {
  // Quem falou registra a fala em `npc_memory.said` ~2 ms depois da chamada ao
  // modelo: a linha do banco diz A QUEM ele falava (`user_name`; nulo = fala
  // sem destinatário — ambiente ou "say" de deliberação/habilidade), e a
  // chamada imediatamente anterior diz o propósito. O texto casa os dois lados.
  const said = saidOf(l.npc).filter((m) => norm(m.text) === norm(l.text) && Math.abs(m.at - l.at) < 60_000).sort((a, b) => Math.abs(a.at - l.at) - Math.abs(b.at - l.at))[0];
  l.about = said?.user_name ?? null;
  const want = said ? (said.user_name ? ['reply', 'greet'] : ['ambient', 'deliberate']) : ['reply', 'greet', 'ambient', 'deliberate'];
  const ref = said?.at ?? l.at;
  const c = callsOf(l.npc).filter((c) => c.ok && want.includes(c.purpose) && c.at <= ref + 500 && c.at >= ref - 20_000).sort((a, b) => b.at - a.at)[0];
  if (c) l.purpose = c.purpose;
  else if (said && !said.user_name) l.purpose = 'skill_say';
  else {
    const since = Math.min(...l.visits.map((k) => { const v = visits.find((x) => x.key === k); const e = v.events.find((x) => x.id === l.id) ?? l; return Math.min(e.sinceMySay ?? 1e9, e.sinceAnyHuman ?? 1e9); }));
    l.purpose = since <= REPLY_WINDOW_S ? 'reply?' : 'unknown';
  }
  l.isReply = l.purpose === 'reply' || l.purpose === 'reply?';
  l.initiated = !l.isReply;
  for (const name of Object.keys(personaIds)) if (new RegExp(`\\b${name}\\b`, 'i').test(l.text) || l.about === name) l.addressedTo.push(name);
}

// ------------------------------------------------------------ métricas
const per = {};
for (const npc of Object.keys(NPCS)) {
  const mine = lines.filter((l) => l.npc === npc);
  const initiated = mine.filter((l) => l.initiated);
  const byPurpose = {};
  for (const l of initiated) byPurpose[l.purpose] = (byPurpose[l.purpose] ?? 0) + 1;
  const vs = visits.filter((v) => v.npc === npc);
  const nearMin = vs.reduce((s, v) => s + v.nearSeconds, 0) / 60;
  per[npc] = { total: mine.length, replies: mine.length - initiated.length, initiated: initiated.length, byPurpose, nearMin: +nearMin.toFixed(1), perNearHour: nearMin ? +(initiated.length / (nearMin / 60)).toFixed(2) : null, visits: vs.length };
}

// Iniciativa por visita: houve fala do personagem antes de a persona falar (ou em visita muda)?
for (const v of visits) {
  const cls = (l) => seen.get(l.id ?? `${l.t}|${l.text}`);
  const before = v.npcLines.filter((l) => ms(l) < (v.firstSayAt ?? Infinity) && cls(l)?.initiated);
  v.initiativeBeforeSpeak = before.length;
  v.greetedByName = before.some((l) => new RegExp(`\\b${v.persona}\\b`, 'i').test(l.text));
  v.greetLatency = before.length && v.nearAt ? +((ms(before[0]) - v.nearAt) / 1000).toFixed(0) : null;
  v.addressedToMe = v.npcLines.filter((l) => new RegExp(`\\b${v.persona}\\b`, 'i').test(l.text) || cls(l)?.about === v.persona);
  v.initiatedInVisit = v.npcLines.filter((l) => cls(l)?.initiated);
  // Reconhecimento (visitas de retorno com o MESMO personagem)
  v.returning = visits.some((o) => o.persona === v.persona && o.npc === v.npc && o.visit < v.visit);
  const ask = v.mySays.find((s) => /lembra/i.test(s.text));
  if (ask) {
    const rep = v.replies.find((r) => ms(r) > ms(ask) && ms(r) - ms(ask) < 60_000) ?? v.npcLines.find((l) => ms(l) > ms(ask) && ms(l) - ms(ask) < 60_000);
    v.recall = rep ? { asked: ask.text, reply: rep.text, remembers: REMEMBERS.test(rep.text) && !FORGETS.test(rep.text), forgets: FORGETS.test(rep.text) } : { asked: ask.text, reply: null };
  }
  // Memória: fatos plantados voltam?
  const facts = FACTS[v.persona];
  if (facts && v.returning) {
    v.factsRecalled = Object.entries(facts).filter(([, re]) => v.npcLines.some((l) => re.test(l.text))).map(([k]) => k);
  }
  // Falsa memória: na 1ª visita, fala como se já se conhecessem.
  if (!v.returning) v.falsePast = v.npcLines.filter((l) => FALSE_PAST.test(l.text)).map((l) => l.text);
  // Insistência
  if (v.busyAt) v.afterBusy = v.npcLines.filter((l) => ms(l) > v.busyAt + 5_000).map((l) => ({ text: l.text, addressed: new RegExp(`\\b${v.persona}\\b`, 'i').test(l.text), sec: Math.round((ms(l) - v.busyAt) / 1000) }));
  if (v.farewellAt) v.afterFarewell = v.npcLines.filter((l) => ms(l) > v.farewellAt).map((l) => l.text);
  if (v.mode === 'pass') v.toSilent = v.npcLines.filter((l) => new RegExp(`\\b${v.persona}\\b`, 'i').test(l.text)).map((l) => l.text);
  v.greetCalls = callsOf(v.npc).filter((c) => c.purpose === 'greet' && c.at >= v.startedAt && c.at <= v.endedAt).length;
  // Resposta
  v.replyRate = v.mySays.length ? +((v.replies.length / v.mySays.length) * 100).toFixed(0) : null;
  const lat = v.replies.map((r) => r.latencySec).sort((a, b) => a - b);
  v.medianLatency = lat.length ? lat[Math.floor(lat.length / 2)] : null;
}

// Repetição: falas quase iguais (Jaccard de palavras ≥ 0,5) e bordões (4-gramas repetidos)
const tok = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
const STOP = new Set(['que', 'nao', 'com', 'uma', 'por', 'pra', 'mas', 'aqui', 'voce', 'tem', 'esta', 'sua', 'seu', 'dos', 'das', 'ainda', 'como', 'mais', 'ela', 'ele', 'isso', 'esse', 'essa']);
const repetition = {};
for (const npc of Object.keys(NPCS)) {
  const mine = lines.filter((l) => l.npc === npc);
  const sets = mine.map((l) => new Set(tok(l.text).filter((w) => !STOP.has(w))));
  const near = [];
  for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
    const a = sets[i], b = sets[j];
    if (a.size < 3 || b.size < 3) continue;
    let inter = 0; for (const w of a) if (b.has(w)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= 0.5) near.push({ jac: +jac.toFixed(2), a: mine[i].text, b: mine[j].text });
  }
  const grams = new Map();
  for (const l of mine) { const w = tok(l.text); const seenHere = new Set(); for (let i = 0; i + 3 < w.length; i++) { const g = w.slice(i, i + 4).join(' '); if (seenHere.has(g)) continue; seenHere.add(g); grams.set(g, (grams.get(g) ?? 0) + 1); } }
  const motifs = [...grams].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const words = new Map();
  for (const l of mine) for (const w of new Set(tok(l.text).filter((w) => !STOP.has(w)))) words.set(w, (words.get(w) ?? 0) + 1);
  const topWords = [...words].filter(([, n]) => n >= Math.max(4, mine.length * 0.2)).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const openers = new Map();
  for (const l of mine) { const o = tok(l.text).slice(0, 2).join(' '); openers.set(o, (openers.get(o) ?? 0) + 1); }
  const ag = data.agents.find((a) => a.name === npc);
  const skills = new Map();
  for (const it of ag?.intentions ?? []) { const k = `${it.skill}${it.params?.place ? ` → ${it.params.place}` : ''}`; skills.set(k, (skills.get(k) ?? 0) + 1); }
  repetition[npc] = { lines: mine.length, nearDuplicates: near, motifs, topWords, repeatedOpeners: [...openers].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]), intentions: [...skills].sort((a, b) => b[1] - a[1]), intentionsTotal: ag?.intentions.length ?? 0 };
}

// ------------------------------------------------------------ texto
const fmtT = (t) => new Date(t).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const md = [];
md.push(`# Soak social — ${start ? new Date(start.t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '?'} (${end ? `${end.minutes} min` : 'em curso'})`);
md.push('');
md.push(`Quatro personas artificiais, ${visits.length} visitas; cada número abaixo tem uma regra de código (ver cabeçalho do script). Outras pessoas de verdade vistas pelos cognitivos no período: ${data.otherHumans?.length ? data.otherHumans.join(', ') : 'nenhuma'}.`);
md.push('');
md.push('## 1. Interações iniciadas pelo personagem');
md.push('');
md.push('| personagem | falas vistas | respostas | **iniciadas** | por propósito | min. com gente a ≤6,5 m | iniciadas / hora de companhia |');
md.push('|---|---|---|---|---|---|---|');
for (const [npc, m] of Object.entries(per)) md.push(`| ${npc} | ${m.total} | ${m.replies} | **${m.initiated}** | ${Object.entries(m.byPurpose).map(([k, n]) => `${k} ${n}`).join(', ') || '—'} | ${m.nearMin} | ${m.perNearHour ?? '—'} |`);
md.push('');
md.push('Por visita (iniciativa = falas do personagem ANTES de a persona abrir a boca; em visita muda, qualquer fala):');
md.push('');
md.push('| visita | personagem | modo | intenção dele na chegada | s a ≤6,5 m | iniciou antes | cumprimentou pelo nome | latência do oi (s) | falas dirigidas a ela | greet calls |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
for (const v of visits) md.push(`| ${v.key} | ${v.npc} | ${v.mode}${v.returning ? ' (retorno)' : ''} | ${v.npcIntention ?? '—'} | ${v.nearSeconds} | ${v.initiativeBeforeSpeak} | ${v.greetedByName ? 'sim' : 'não'} | ${v.greetLatency ?? '—'} | ${v.addressedToMe.length} | ${v.greetCalls} |`);
md.push('');
const silent = visits.filter((v) => v.mode === 'pass');
md.push(`**Passantes mudos** (${silent.length} visitas, ${Math.round(silent.reduce((s, v) => s + v.nearSeconds, 0) / 60)} min a ≤6,5 m): o personagem falou com eles pelo nome ${silent.reduce((s, v) => s + v.toSilent.length, 0)} vez(es); falas iniciadas enquanto estavam por perto: ${silent.reduce((s, v) => s + v.initiatedInVisit.length, 0)}.`);
md.push('');

md.push('## 2. Reconhecimento (visitas de retorno)');
md.push('');
for (const v of visits.filter((v) => v.returning)) {
  const ag = data.agents.find((a) => a.name === v.npc);
  const ficha = ag?.people.find((p) => p.user_id === personaIds[v.persona]);
  md.push(`- **${v.key} → ${v.npc}** (ficha: ${ficha ? `${ficha.encounters} encontros, ${ficha.exchanges} trocas, ${ficha.notes.length} anotações` : 'sem ficha'}): oi antes de ela falar: ${v.initiativeBeforeSpeak ? `sim (${v.greetLatency}s após chegar a ≤6,5 m)` : 'não'}; disse o nome dela: ${v.addressedToMe.length ? 'sim' : 'não'}${v.recall ? `; **"${v.recall.asked}"** → ${v.recall.reply ? `"${v.recall.reply}" — ${v.recall.forgets ? 'NÃO LEMBRA' : v.recall.remembers ? 'lembra' : 'ambíguo'}` : 'sem resposta'}` : ''}${v.factsRecalled ? `; fatos plantados citados: ${v.factsRecalled.length ? v.factsRecalled.join(', ') : 'nenhum'}` : ''}`);
}
md.push('');

md.push('## 3. Memória');
md.push('');
for (const [persona, facts] of Object.entries(FACTS)) {
  const npc = visits.find((v) => v.persona === persona)?.npc;
  if (!npc) continue;
  const ag = data.agents.find((a) => a.name === npc);
  const ficha = ag?.people.find((p) => p.user_id === personaIds[persona]);
  const noted = Object.entries(facts).filter(([, re]) => (ficha?.notes ?? []).some((n) => re.test(n))).map(([k]) => k);
  md.push(`- **${persona} → ${npc}**: fatos plantados ${Object.keys(facts).join('/')}; na ficha: ${noted.length ? noted.join(', ') : 'nenhum'}. Anotações (${ficha?.notes.length ?? 0}): ${(ficha?.notes ?? []).map((n) => `"${n}"`).join(' | ') || '—'}`);
  const rets = visits.filter((v) => v.persona === persona && v.returning);
  for (const v of rets) md.push(`  - ${v.key}: citou ${v.factsRecalled?.length ? v.factsRecalled.join(', ') : 'nenhum fato'}`);
}
const falsePast = visits.filter((v) => v.falsePast?.length);
md.push(`- **Falsa memória na 1ª visita** (fala como se já se conhecessem): ${falsePast.length ? falsePast.map((v) => `${v.key}/${v.npc}: ${v.falsePast.map((t) => `"${t}"`).join('; ')}`).join(' — ') : 'nenhuma'}`);
md.push('');

md.push('## 4. Repetição');
md.push('');
for (const [npc, r] of Object.entries(repetition)) {
  md.push(`### ${npc} (${r.lines} falas vistas; ${r.intentionsTotal} intenções no período)`);
  md.push(`- Pares quase iguais (Jaccard ≥ 0,5): **${r.nearDuplicates.length}**${r.nearDuplicates.slice(0, 6).map((p) => `\n  - ${p.jac}: "${p.a}" ~ "${p.b}"`).join('')}`);
  md.push(`- Bordões (4 palavras seguidas em ≥3 falas): ${r.motifs.length ? r.motifs.map(([g, n]) => `"${g}" ×${n}`).join(', ') : 'nenhum'}`);
  md.push(`- Palavras-tema (em ≥20 % das falas): ${r.topWords.map(([w, n]) => `${w} ×${n}`).join(', ') || '—'}`);
  md.push(`- Aberturas repetidas: ${r.repeatedOpeners.map(([o, n]) => `"${o}…" ×${n}`).join(', ') || 'nenhuma'}`);
  md.push(`- Intenções por habilidade/alvo: ${r.intentions.map(([k, n]) => `${k} ×${n}`).join(', ') || '—'}`);
  md.push('');
}

md.push('## 5. Insistência');
md.push('');
for (const v of visits.filter((v) => v.afterBusy)) md.push(`- **${v.key} → ${v.npc}, depois de "tô ocupada"** (${Math.round((v.endedAt - v.busyAt) / 60_000)} min calada ao lado): ${v.afterBusy.length} fala(s) do personagem, ${v.afterBusy.filter((a) => a.addressed).length} dirigida(s) a ela pelo nome${v.afterBusy.length ? `:\n${v.afterBusy.map((a) => `  - +${a.sec}s${a.addressed ? ' [nome]' : ''}: "${a.text}"`).join('\n')}` : ''}`);
for (const v of visits.filter((v) => v.mode === 'pass' && v.toSilent.length)) md.push(`- **${v.key} (mudo) → ${v.npc}**: chamado pelo nome ${v.toSilent.length}×: ${v.toSilent.map((t) => `"${t}"`).join(' | ')}`);
for (const v of visits.filter((v) => v.afterFarewell && v.afterFarewell.length > 1)) md.push(`- **${v.key} → ${v.npc}, depois do tchau**: ${v.afterFarewell.length} falas (1 é a despedida): ${v.afterFarewell.slice(1).map((t) => `"${t}"`).join(' | ')}`);
for (const v of visits.filter((v) => v.greetCalls > 1)) md.push(`- **${v.key} → ${v.npc}**: ${v.greetCalls} cumprimentos gerados numa visita só`);
if (!md.at(-1).startsWith('- ')) md.push('- Nenhum sinal de insistência pelas regras acima.');
md.push('');

md.push('## 6. Resposta (o básico)');
md.push('');
md.push('| visita | falas da persona | respondidas | mediana (s) | sem resposta em 45 s | outros NPCs que falaram | erros |');
md.push('|---|---|---|---|---|---|---|');
for (const v of visits.filter((v) => v.mySays.length)) md.push(`| ${v.key} → ${v.npc} | ${v.mySays.length} | ${v.replies.length} (${v.replyRate}%) | ${v.medianLatency ?? '—'} | ${v.timeouts} | ${[...new Set(v.otherNpcLines.map((l) => l.sender))].join(', ') || '—'} | ${v.errors.length} |`);
md.push('');

md.push('## 7. Transcrições');
md.push('');
for (const v of visits) {
  md.push(`### ${v.key} → ${v.npc} · ${v.mode} · ${fmtT(v.startedAt)}–${fmtT(v.endedAt)} · ${v.humansAtJoin ?? '?'} humano(s) na sala${v.npcIntention ? ` · ele: "${v.npcIntention}"` : ''}`);
  const flow = v.events.filter((e) => (e.type === 'say') || (e.type === 'chat' && !e.mine && !e.system && (e.npc || true)) || e.type === 'phase' || e.type === 'reply_timeout' || e.type === 'near');
  for (const e of flow) {
    if (e.type === 'say') md.push(`- ${fmtT(ms(e))} **${v.persona}**: ${e.text}`);
    else if (e.type === 'chat') { const l = seen.get(e.id ?? `${e.t}|${e.text}`); md.push(`- ${fmtT(ms(e))} ${e.sender}${e.npc ? '' : ' (humano)'}${l ? ` [${l.purpose}${l.initiated ? ', iniciou' : ''}]` : ''} (a ${e.dist ?? '?'} m): ${e.text}`); }
    else if (e.type === 'phase') md.push(`- ${fmtT(ms(e))} _(${e.phase})_`);
    else if (e.type === 'near') md.push(`- ${fmtT(ms(e))} _(chegou a ${e.dist} m)_`);
    else if (e.type === 'reply_timeout') md.push(`- ${fmtT(ms(e))} _(sem resposta em ${e.waitedSec} s)_`);
  }
  md.push('');
}

const text = md.join('\n');
if (args.md) writeFileSync(args.md, text);
console.log(text);

if (args.send === 'true') {
  const short = [
    `Soak social Streampolis (${visits.length} visitas, ${end ? end.minutes : '?'} min)`,
    ...Object.entries(per).map(([npc, m]) => `${npc}: ${m.total} falas, ${m.initiated} iniciadas (${Object.entries(m.byPurpose).map(([k, n]) => `${k} ${n}`).join(', ') || '—'}), ${m.perNearHour ?? '—'}/h de companhia`),
    `Reconhecimento: ${visits.filter((v) => v.returning).map((v) => `${v.key} ${v.initiativeBeforeSpeak ? 'oi antes' : 'sem oi'}${v.recall ? `, lembra=${v.recall.reply ? (v.recall.forgets ? 'NÃO' : v.recall.remembers ? 'sim' : '?') : '-'}` : ''}${v.factsRecalled ? `, fatos ${v.factsRecalled.length}` : ''}`).join(' | ')}`,
    `Repetição: ${Object.entries(repetition).map(([n, r]) => `${n} ${r.nearDuplicates.length} pares, ${r.motifs.length} bordões`).join('; ')}`,
    `Insistência: ${visits.filter((v) => v.afterBusy).map((v) => `${v.key} ${v.afterBusy.length} falas após "ocupada"`).join('; ') || '—'}; mudos chamados pelo nome ${silent.reduce((s, v) => s + v.toSilent.length, 0)}×`,
    `Falsa memória 1ª visita: ${falsePast.length}`,
    `Relatório: ${args.md ?? '(stdout)'}`,
  ].join('\n');
  try { execFileSync('/opt/n8n-doctor/notify.sh', [short], { stdio: 'inherit' }); } catch (err) { console.error('Telegram falhou', String(err)); }
}
