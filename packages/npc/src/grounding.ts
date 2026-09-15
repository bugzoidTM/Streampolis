import type { Weather } from './shared.js';
import { fold } from './text.js';

/**
 * FATOS × INTERPRETAÇÃO no "why" do personagem cognitivo.
 *
 * O modelo justifica o plano num "why" — e, sem dado, preenche com inferência
 * dita como fato: "ninguém esteve aqui hoje", "o letreiro mudou", "os postes
 * acenderam há pouco". Nada disso foi observado: o mundo fornece clima,
 * dia/noite, quem está na cena e os eventos registrados (choveu, anoiteceu,
 * fulano chegou/saiu); do letreiro não há dado nenhum. Aqui se diz ao modelo
 * o que ele SABE (`factLines`) e se confere o que ele AFIRMOU (`auditWhy`):
 * a frase que afirma um evento sem dado correspondente vira, no registro,
 * suposição declarada — não é apagada, mas deixa de valer como fato (e como
 * motivo para repetir). Frase com hedge ("acho que", "quero ver se") já é
 * interpretação e passa.
 */
export interface ObservedEvent {
  /** Como o cérebro registrou ("começou a chover", "Ana chegou"). */
  what: string;
  ageMin: number;
}

export interface Facts {
  /** Nulo quando o clima não se aplica à cena (ou é desconhecido). */
  weather: Weather | null;
  night: boolean | null;
  /** Nomes de gente (de verdade) presente agora. */
  people: string[];
  /** Eventos observados na janela recente. */
  events: ObservedEvent[];
  /** Gente vista desde o início do registro de hoje; nulo = não há registro de hoje (não se sabe). */
  seenToday: string[] | null;
}

export interface WhyAuditResult {
  why: string;
  /** As frases que afirmaram o que não foi observado (no original). */
  unsupported: string[];
}

/** "Há pouco" só é verdade se o evento tem no máximo isto de idade. */
export const RECENT_MIN = 15;

type EventKind = 'rain_start' | 'rain_stop' | 'nightfall' | 'daybreak' | 'arrival' | 'departure';

/** Classifica um evento registrado pelo cérebro. */
export function eventKind(what: string): EventKind | null {
  const f = fold(what);
  if (/comecou a chover|voltou a chover/.test(f)) return 'rain_start';
  if (/parou de chover/.test(f)) return 'rain_stop';
  if (/anoiteceu/.test(f)) return 'nightfall';
  if (/amanheceu/.test(f)) return 'daybreak';
  if (/\bchegou\b|\bchegaram\b/.test(f)) return 'arrival';
  if (/\bsaiu\b|\bsairam\b|foi embora/.test(f)) return 'departure';
  return null;
}

const HEDGE = /\b(acho|achei|parece|parecia|imagino|imaginei|talvez|quem sabe|sera que|deve (ser|estar|ter)|pode (ser|estar|ter)|quero (ver|saber|conferir|descobrir|sentir|olhar)|ver se|conferir se|saber se|descobrir se|curios\w*|sinto|impressao|suponho|aposto|vai ver|de repente|provavel\w*|gosto de|gostaria|vontade)\b/;

const RECENCY = /\b(ha pouco|agora ha pouco|agorinha|acabou de|acabaram de|acaba de|acabam de|recem|faz pouco|ainda agora|ha instantes|neste instante|agora mesmo|ha minutos|ha uns minutos)\b/;

/** O assunto da frase, para saber que dado a sustentaria. */
function subjectOf(f: string): 'rain' | 'night' | 'people' | null {
  if (/\b(chuv\w*|chov\w*|garoa\w*|molhad\w*|poca\w*|temporal|estiou|estiar)\b/.test(f)) return 'rain';
  if (/\b(noite|anoitec\w*|escur\w*|amanhec\w*|clareou|luz|luzes|poste\w*|acend\w*|apag\w*|lampada\w*|iluminac\w*|madrugada)\b/.test(f)) return 'night';
  if (/\b(gente|alguem|ninguem|pessoa\w*|visita\w*|movimento|rosto\w*|cara\w*|alma|turista\w*|cliente\w*|visitante\w*|frequentador\w*)\b/.test(f)) return 'people';
  return null;
}

interface Claim {
  /** Que evento sustentaria a afirmação; vazio = nenhum dado do mundo sustenta (letreiro, telão…). */
  needs: EventKind[];
  /** Precisa ter acontecido há pouco. */
  recent: boolean;
  /** Sustentada por um estado, não por evento: "ninguém esteve aqui hoje". */
  state?: 'nobody_today';
}

/** As afirmações factuais de uma frase (já sem acento e em minúsculas). */
export function claimsOf(f: string): Claim[] {
  const claims: Claim[] = [];
  const subject = subjectOf(f);
  const recent = RECENCY.test(f);

  // Ausência de gente ao longo de um período.
  if (/\b(ninguem|nenhuma (pessoa|alma|viva alma)|nem uma alma|nem um gato)\b[^.;]*\b(esteve|passou|veio|apareceu|chegou|andou|parou|ficou|entrou|pisou|hoje|o dia (todo|inteiro)|a manha (toda|inteira)|a tarde (toda|inteira)|a noite (toda|inteira)|ate agora|desde|ainda)\b/.test(f)
    || /\b(nao|sem) (veio|passou|apareceu|chegou|pisou|esteve)( aqui)? ninguem\b/.test(f)
    || /\b(sem ninguem|vazi[oa]|desert[oa]|as moscas)\b[^.;]*\b(hoje|o dia (todo|inteiro)|a manha|a tarde|a noite|desde|ate agora|ha horas)\b/.test(f)) {
    claims.push({ needs: [], recent: false, state: 'nobody_today' });
  }

  // Chuva que começou ou parou.
  if (/\b((comecou|comeca|voltou|volta|passou) a (chover|garoar|pingar)|caiu (uma |a )?chuva|desabou|chuva (nova|chegou|chegando|comecou|voltou))\b/.test(f)) claims.push({ needs: ['rain_start'], recent });
  if (/\b((parou|estiou|passou) (de chover|a chuva|de garoar)|chuva (parou|passou|estiou|foi embora)|estiou)\b/.test(f)) claims.push({ needs: ['rain_stop'], recent });

  // Noite que caiu, dia que nasceu, luzes.
  if (/\b(anoiteceu|escureceu|a noite (caiu|chegou|desceu)|caiu a noite|(chegou|virou) a noite)\b/.test(f)) claims.push({ needs: ['nightfall'], recent });
  if (/\b(amanheceu|clareou|o dia (nasceu|chegou|clareou|raiou)|raiou)\b/.test(f)) claims.push({ needs: ['daybreak'], recent });
  // Só a forma de EVENTO ("acendeu", "apagaram"): "a chama não apaga" é estado, não acontecimento.
  if (/\b(acendeu|acenderam|acendeu-se|acenderam-se|se acendeu|se acenderam|acabou de acender|acabaram de acender)\b/.test(f)) claims.push({ needs: ['nightfall'], recent });
  if (/\b(apagou|apagaram|apagou-se|apagaram-se|se apagou|se apagaram|acabou de apagar|acabaram de apagar)\b/.test(f)) claims.push({ needs: ['daybreak'], recent });

  // Gente que chegou ou foi embora (quando o assunto não é chuva nem noite).
  if (subject !== 'rain' && subject !== 'night') {
    if (/\b(chegou|chegaram|apareceu|apareceram|surgiu|surgiram|gente nova|alguem novo|cara(s)? nova(s)?|rosto(s)? novo(s)?|movimento (novo|aumentou|cresceu)|encheu)\b/.test(f)) claims.push({ needs: ['arrival'], recent });
    if (/\b(foi embora|foram embora|sumiu|sumiram|saiu|sairam|esvaziou|debandou|dispersou)\b/.test(f)) claims.push({ needs: ['departure'], recent });
  }

  // Mudança genérica: "mudou", "está diferente", "o letreiro piscou".
  if (/\b(mudou|mudaram|mudanca|trocou|trocaram|trocad[oa]|esta(o)? diferente(s)?|ficou diferente|ficaram diferentes|piscou|piscando|ligou|ligaram|desligou|desligaram|quebrou|consertaram|reformaram|pintaram|nov[oa] (luz|cor|placa|letreiro|som|musica|cheiro))\b/.test(f)) {
    claims.push({ needs: subject === 'rain' ? ['rain_start', 'rain_stop'] : subject === 'night' ? ['nightfall', 'daybreak'] : subject === 'people' ? ['arrival', 'departure'] : [], recent });
  }

  // "Há pouco" sem afirmação reconhecida acima: precisa de ALGUM evento recente do assunto.
  if (recent && !claims.length) {
    claims.push({ needs: subject === 'rain' ? ['rain_start', 'rain_stop'] : subject === 'night' ? ['nightfall', 'daybreak'] : subject === 'people' ? ['arrival', 'departure'] : ['rain_start', 'rain_stop', 'nightfall', 'daybreak', 'arrival', 'departure'], recent: true });
  }
  return claims;
}

function supported(claim: Claim, facts: Facts): boolean {
  if (claim.state === 'nobody_today') {
    return facts.seenToday !== null && facts.seenToday.length === 0 && facts.people.length === 0;
  }
  if (!claim.needs.length) return false;
  return facts.events.some((e) => {
    const k = eventKind(e.what);
    return k !== null && claim.needs.includes(k) && (!claim.recent || e.ageMin <= RECENT_MIN);
  });
}

/** Frases (com o separador de volta), para marcar só a que erra. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.;!?])\s+|\s+—\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Confere o "why": cada frase que afirma um evento sem dado que o sustente
 * volta marcada como suposição. Devolve também as frases originais que
 * falharam, para o registro (`why_audit`) e para o aviso.
 */
export function auditWhy(why: string | null, facts: Facts): WhyAuditResult {
  if (!why) return { why: why ?? '', unsupported: [] };
  const unsupported: string[] = [];
  const out = sentences(why).map((s) => {
    const f = fold(s);
    if (HEDGE.test(f)) return s;
    const claims = claimsOf(f);
    if (!claims.length || claims.every((c) => supported(c, facts))) return s;
    unsupported.push(s);
    return `(suposição, sem dado) ${s}`;
  });
  return { why: out.join(' '), unsupported };
}

/** O bloco FATOS OBSERVADOS do prompt: o que o mundo forneceu — e o que ele NÃO forneceu. */
export function factLines(facts: Facts, opts: { weatherApplies: boolean }): string[] {
  const out: string[] = [];
  out.push(`- Clima: ${!opts.weatherApplies ? 'não muda aqui (o bairro é como é)' : facts.weather === 'rain' ? 'chovendo' : facts.weather === 'clear' ? 'tempo aberto' : 'desconhecido'}.`);
  out.push(`- ${facts.night === null ? 'Dia/noite: desconhecido' : facts.night ? 'É noite' : 'É dia'}.`);
  out.push(`- Gente (de verdade) presente agora: ${facts.people.length ? facts.people.join(', ') : 'ninguém'}.`);
  out.push(facts.seenToday === null
    ? '- Quem passou por aqui hoje: você não tem registro (não afirme que ninguém veio).'
    : `- Quem passou por aqui hoje, pelo seu registro: ${facts.seenToday.length ? facts.seenToday.join(', ') : 'ninguém até agora'}.`);
  out.push(facts.events.length
    ? `- Eventos que você viu acontecer: ${facts.events.slice(0, 8).map((e) => `${e.what} (há ${e.ageMin} min)`).join('; ')}.`
    : '- Eventos que você viu acontecer: nenhum na última hora e pouco.');
  out.push('- Você NÃO tem dado sobre: letreiros, telão, luzes além de dia/noite, sons, cheiros, o que mudou em qualquer coisa que não esteja acima.');
  return out;
}
