import type { Archetype } from './roster.js';
import type { Stage } from './relations.js';
import { fold } from './text.js';

/**
 * A fala do personagem social: intenção por regra, resposta por modelo.
 *
 * Nenhum modelo de linguagem. O que a pessoa escreveu é classificado numa
 * lista fechada de intenções (`detect`), e a resposta sai de um banco de
 * frases por arquétipo e por estágio da relação (`compose`), com lacunas
 * preenchidas pelo que o personagem sabe: o nome da pessoa, o lugar, a hora,
 * um fato que ela contou. As regras de conduta (PRD §25: nunca passar por
 * gente; nunca prometer moeda) estão ESCRITAS nas frases — não há como uma
 * resposta violá-las, porque não há resposta fora do banco.
 *
 * Variedade vem de três lugares: várias frases por chave, a memória das
 * últimas usadas com cada pessoa (não repete), e o estágio/humor escolhendo
 * a chave. É menos do que um modelo faria e muito mais do que "..." — e custa
 * zero.
 */

export type Intent =
  | 'greet' | 'bye' | 'how_are_you' | 'who_are_you' | 'are_you_real' | 'what_place' | 'where_is'
  | 'what_time' | 'compliment' | 'insult' | 'thanks' | 'laugh' | 'follow_me' | 'stay' | 'stop_follow'
  | 'take_me' | 'sit' | 'dance' | 'help' | 'about_self' | 'yes' | 'no' | 'question' | 'unknown';

export interface Detected {
  intent: Intent;
  /** O trecho que nomeia um lugar, para `findPlace`. */
  placeText?: string;
  /** Um fato que a pessoa disse de si, já em terceira pessoa. */
  fact?: string;
}

const INSULTS = [
  'idiota', 'burro', 'burra', 'otario', 'otaria', 'lixo', 'imbecil', 'babaca', 'nojento', 'nojenta', 'feio', 'feia',
  'chato', 'chata', 'inutil', 'ridiculo', 'ridicula', 'merda', 'bosta', 'porra', 'caralho', 'fdp', 'vsf', 'vtnc', 'cala a boca',
  'some daqui', 'sai daqui', 'vai embora', 'te odeio', 'odeio voce', 'estupido', 'estupida', 'palhaco', 'palhaca', 'bot lixo',
];

function has(t: string, words: string[]): boolean {
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t));
}

export function detect(raw: string): Detected {
  const t = fold(raw).replace(/[^a-z0-9@?!\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { intent: 'unknown' };

  if (has(t, INSULTS)) return { intent: 'insult' };

  // Pedidos ao corpo antes de tudo: "vem comigo" tem "vem", que é cumprimento.
  if (/\b(para|pare) de (me )?seguir\b|\bnao (me )?segue\b|\bpode parar\b|\bme deixa\b|\bfica ai\b|\bnao vem\b/.test(t)) return { intent: 'stop_follow' };
  if (/\bfica (aqui|comigo|ai)\b|\bespera( aqui| ai)?\b|\bnao sai( daqui)?\b|\bme espera\b/.test(t)) return { intent: 'stay' };
  if (/\b(vem|vamo|vamos|bora) comigo\b|\bme segue\b|\bsegue eu\b|\bme acompanha\b|\banda comigo\b|\bvem junto\b|\bme segui\b/.test(t)) return { intent: 'follow_me' };
  const take = /\b(me leva|leva eu|me mostra|vamo(s)? (ate|pro|pra|para|no|na)|bora (pro|pra|para|no|na)|me acompanha (ate|pro|pra))\b\s*(.*)$/.exec(t);
  if (take) return { intent: 'take_me', placeText: take[take.length - 1] || t };
  if (/\bsenta\b|\bvamo(s)? sentar\b|\bbora sentar\b|\bsenta (aqui|comigo|ai)\b/.test(t)) return { intent: 'sit' };
  if (/\bdanca\b|\bvamo(s)? dancar\b|\bbora dancar\b|\bdanca comigo\b/.test(t)) return { intent: 'dance' };

  if (/\b(voce|vc|tu|ce) (e|eh) (um )?(bot|npc|robo|ia|personagem|maquina|humano|humana|gente|real|de verdade|pessoa)\b|\b(e|eh) (bot|npc|robo|humano|real|de verdade)\b|\bvoce existe\b|\b(alguem|tem gente) ai\b/.test(t)) return { intent: 'are_you_real' };
  if (/\bquem (e|eh) (voce|vc|tu|ce)\b|\bseu nome\b|\bte chama\b|\bquem e\b|\bo que (voce|vc) faz\b|\bfaz o que\b|\bvoce faz o que\b|\bvc e quem\b|\bconta de voce\b|\bfala de voce\b/.test(t)) return { intent: 'who_are_you' };
  if (/\bque horas\b|\bque hora\b|\bhorario\b|\bque dia\b/.test(t)) return { intent: 'what_time' };
  const where = /\b(onde|aonde|cade|como (eu )?chego|como (eu )?vou|fica onde|onde fica|onde e|onde tem|onde esta)\b\s*(.*)$/.exec(t);
  if (where) return { intent: 'where_is', placeText: where[where.length - 1] || t };
  if (/\bque lugar\b|\bo que (e|eh) (isso|isto|aqui|esse lugar)\b|\bonde (eu )?(estou|to)\b|\bo que tem (aqui|pra fazer|para fazer)\b|\bo que rola\b|\bcomo funciona\b|\bque cidade\b|\bo que e streampolis\b/.test(t)) return { intent: 'what_place' };
  if (/\b(me )?ajuda\b|\bsocorro\b|\bcomo (faz|faco|fazer)\b|\bnao sei\b.*\b(fazer|jogar|ir)\b|\bo que (eu )?faco\b|\bme explica\b/.test(t)) return { intent: 'help' };

  if (/\b(tudo bem|tudo bom|como (vai|vc ta|voce ta|ce ta|esta|tu ta|voce esta)|beleza\?|de boa\?|suave\?|blz\?|como (voce|vc|tu) (ta|esta|anda))\b/.test(t) || /^(tudo bem|blz|beleza|suave|de boa)[?!]*$/.test(t)) return { intent: 'how_are_you' };

  if (/\b(tchau|falou|fui|ate mais|ate logo|xau|flw|bjs|beijo|adeus|boa noite pra voce|vou nessa|to indo|tenho que ir|ate amanha|vou indo)\b/.test(t)) return { intent: 'bye' };
  if (/\b(obrigad[oa]|valeu|vlw|brigad[oa]|agradec|thanks|obg)\b/.test(t)) return { intent: 'thanks' };
  if (/\b(kkk+|haha+|rsrs+|hehe+|lol|kk)\b|^k+$/.test(t)) return { intent: 'laugh' };
  if (/\b(legal|lindo|linda|massa|show|incrivel|gostei|gosto de voce|te amo|top|maneiro|maneira|bonito|bonita|estiloso|estilosa|simpatico|simpatica|gente boa|voce e (o|a) melhor|adorei|amei|que fofo|que fofa|perfeito|perfeita|demais|otimo|otima)\b/.test(t)) return { intent: 'compliment' };

  const fact = extractFact(t);
  if (fact) return { intent: 'about_self', fact };

  if (/\b(oi+|ola|opa|eai|e ai|eae|salve|fala|bom dia|boa tarde|boa noite|hey|hello|alo|coe|oie)\b/.test(t)) return { intent: 'greet' };
  if (/^(sim|s|isso|claro|pode|aham|uhum|bora|vamos|ok|okay|beleza|fechou|demorou|pode ser|com certeza)[!.]*$/.test(t)) return { intent: 'yes' };
  if (/^(nao|n|nem|jamais|nunca|deixa|melhor nao|agora nao|nops|nope)[!.]*$/.test(t)) return { intent: 'no' };
  if (/\?$/.test(t) || /^(por que|porque|pq|como|qual|quais|quando|quanto)\b/.test(t)) return { intent: 'question' };
  return { intent: 'unknown' };
}

/**
 * Um fato que a pessoa disse de si, guardado em terceira pessoa. Só padrões
 * explícitos ("sou de", "moro em", "trabalho com", "gosto de") — nada de
 * inferência: a anotação errada é pior que nenhuma.
 */
export function extractFact(t: string): string | undefined {
  const cut = (s: string) => s.replace(/[?!.].*$/, '').trim().split(' ').slice(0, 5).join(' ');
  let m = /\b(eu )?(sou|so) (de|do|da|la de) ([a-z0-9 ]{2,30})/.exec(t);
  if (m && !/\b(bot|npc|humano|real|verdade|jogador|streamer|fa|novo|nova)\b/.test(m[4]!)) return `é de ${cut(m[4]!)}`;
  m = /\b(eu )?moro (em|no|na) ([a-z0-9 ]{2,30})/.exec(t);
  if (m) return `mora em ${cut(m[3]!)}`;
  m = /\b(eu )?trabalho (com|de|como|em|no|na) ([a-z0-9 ]{2,30})/.exec(t);
  if (m) return `trabalha com ${cut(m[3]!)}`;
  m = /\b(eu )?(gosto|curto|adoro|amo) (de |muito de )?([a-z0-9 ]{2,30})/.exec(t);
  if (m && !/\b(voce|vc|ti|tu)\b/.test(m[4]!.split(' ')[0]!)) return `gosta de ${cut(m[4]!)}`;
  m = /\b(eu )?(estudo|faco faculdade de|faco curso de) ([a-z0-9 ]{2,30})/.exec(t);
  if (m) return `estuda ${cut(m[3]!)}`;
  m = /\b(eu )?tenho (\d{1,2}) anos\b/.exec(t);
  if (m) return `tem ${m[2]} anos`;
  m = /\b(eu )?(faco|sou) (live|lives|streamer)\b/.exec(t);
  if (m) return 'faz lives';
  return undefined;
}

// ---------------------------------------------------------------- bancos ---

export interface Slots {
  name: string;
  npc: string;
  scene: string;
  time: string;
  place?: string;
  bearing?: string;
  fact?: string;
  quirk?: string;
  topic?: string;
  other?: string;
  /** Quantas vezes já se viram (para "sua 3ª vez"). */
  encountersN?: number;
}

type Bank = Partial<Record<string, string[]>>;

/** Frases que todo arquétipo tem; o arquétipo sobrescreve o que quiser. */
const COMMON: Bank = {
  greet_stranger: [
    'Oi, {name}. Não te conheço ainda — mas isso se resolve.',
    'Opa. {name}, né? Bem-vindo a {scene}.',
    'Oi. Primeira vez por aqui, {name}?',
    'E aí, {name}. Tudo tranquilo por {scene}.',
  ],
  greet_known: [
    'Oi de novo, {name}.',
    'Olha quem voltou. Tudo bem, {name}?',
    '{name}! Achei que não ia te ver hoje.',
    'E aí, {name}. Já é a sua {encounters}ª vez por aqui, se não me engano.',
  ],
  greet_friend: [
    '{name}! Estava mesmo lembrando de você.',
    'Aí sim, {name}. O dia melhora quando você aparece.',
    'Meu amigo {name}. Senta, conta.',
    '{name}, que bom te ver. {fact_line}',
  ],
  greet_close: [
    '{name}! Você de novo é a melhor parte de {scene}.',
    'Chegou quem faltava. Oi, {name}.',
    '{name}, você já é de casa. {fact_line}',
  ],
  greet_grudge: [
    'Hm. Oi, {name}.',
    'Ah. Você.',
    'Oi. Sem muito papo hoje, {name}.',
  ],
  bye: [
    'Até mais, {name}. Aparece.',
    'Vai com cuidado, {name}.',
    'Tchau, {name}. Volta amanhã?',
    'Falou. Fico por aqui, como sempre.',
  ],
  bye_friend: [
    'Já? Vou sentir falta, {name}. Volta logo.',
    'Tchau, {name}. Amanhã eu te espero no mesmo lugar.',
  ],
  how_are_you: [
    'Tô bem, {name}. {time_line}',
    'Na paz. E você, {name}?',
    'Tudo certo por aqui. {topic}',
    'Bem, considerando que eu nunca saio de {scene}.',
  ],
  how_are_you_low: [
    'Já estive melhor, {name}. Mas passa.',
    'Meio devagar hoje. E você?',
    'Cansado. Mas conversar ajuda.',
  ],
  who_are_you: [
    '{intro}',
    '{intro} E você, {name}?',
  ],
  are_you_real: [
    'Sou personagem daqui, {name} — de carne e osso só você. Mas conversar eu converso.',
    'Real, real, não. Sou um personagem de {scene}. Mas eu lembro de quem volta.',
    'Personagem da cidade. Não sou jogador nem gente — e não finjo ser.',
  ],
  what_place: [
    'Isso aqui é {scene}. {scene_line}',
    '{scene}. {scene_line} E eu vivo por aqui.',
  ],
  where_is_known: [
    '{place}? Fica {bearing}.',
    'Ali, {bearing}: {place}.',
    'Você quer {place}. Está {bearing} de onde a gente está.',
  ],
  where_is_unknown: [
    'Isso eu não sei te dizer. Conheço só {scene}.',
    'Não conheço esse lugar. Tenta perguntar ao Nilo, na praça — ele sabe mais.',
    'Não faço ideia, {name}. Minha geografia acaba em {scene}.',
  ],
  what_time: [
    'Agora são {clock}, hora de Brasília. {time_line}',
    '{clock}. {time_line}',
  ],
  compliment: [
    'Ué, obrigado, {name}. Vou guardar essa.',
    'Para com isso que eu fico sem graça.',
    'Você também, {name}. Digo isso sem ganhar nada por isso.',
  ],
  compliment_low: [
    'Valeu. Precisava ouvir algo assim hoje.',
  ],
  insult: [
    'Tá bom, {name}. Sem essa.',
    'Não vou entrar nessa. Boa noite.',
    'Ok. Vou dar uma volta.',
  ],
  insult_patient: [
    'Dia ruim, {name}? Acontece. Quando melhorar, eu tô por aqui.',
    'Vou fingir que não ouvi. Uma vez.',
  ],
  insult_grudge: [
    'De novo? Já entendi o que você acha de mim.',
    'Não, {name}. Chega.',
  ],
  thanks: [
    'Por nada, {name}.',
    'Disponha. É o que eu faço por aqui.',
    'Imagina.',
  ],
  laugh: [
    'Hehe. Boa.',
    'Rindo também, {name}.',
    'Pelo menos alguém achou graça.',
  ],
  follow_accept: [
    'Bora, {name}. Vou atrás.',
    'Tá. Mas não me deixa para trás.',
    'Vamos. Você guia.',
  ],
  follow_decline: [
    'A gente mal se conhece, {name}. Fica mais um pouco, conversa, depois a gente vê.',
    'Hoje não. Mas volta que a gente se conhece melhor.',
    'Ainda não, {name}. Eu não saio atrás de qualquer um.',
  ],
  follow_decline_grudge: [
    'Depois do que você disse? Não.',
  ],
  stay_ok: [
    'Fico. Mas não demora.',
    'Tá bom, {name}. Aqui.',
  ],
  stop_ok: [
    'Beleza, paro aqui.',
    'Tá. Fico por aqui então.',
  ],
  take_me_accept: [
    'Vem. {place} é {bearing}, eu te levo.',
    'Bora até {place}. Me segue.',
  ],
  take_me_decline: [
    'Sei onde é: {place}, {bearing}. Mas ir junto é para quem eu já conheço, {name}.',
    '{place} fica {bearing}. Vai na frente que eu te vejo daqui.',
  ],
  take_me_unknown: [
    'Não conheço esse lugar. Só ando por {scene}.',
  ],
  sit_ok: [
    'Boa ideia. Senta aí.',
    'Vamos sentar, {name}. Meus pés agradecem.',
  ],
  sit_no: [
    'Aqui não tem onde sentar. A praça tem banco.',
  ],
  dance_ok: [
    'Bora! Desde que ninguém filme.',
    'Ah, agora sim, {name}.',
  ],
  dance_no: [
    'Dançar aqui? Não é o lugar. No Clube Sombra, talvez.',
  ],
  help: [
    'Por aqui dá para andar, conversar, entrar nas portas. Para o resto, o Nilo na praça explica melhor que eu.',
    'Anda pela cidade, fala com quem passa. As portas levam a lugares. Eu só sei o meu canto.',
  ],
  about_self: [
    'Então você {fact}. Vou lembrar disso, {name}.',
    '{fact_cap}, é? Anotado.',
    'Legal saber que você {fact}.',
  ],
  yes: [
    'Combinado então.',
    'Boa.',
  ],
  no: [
    'Tudo bem.',
    'Sem problema, {name}.',
  ],
  question: [
    'Boa pergunta. Eu não sei — só sei o que se vê por {scene}.',
    'Isso eu não sei te responder, {name}.',
    'Não faço ideia. O Nilo, na praça, talvez saiba.',
  ],
  unknown: [
    'Hm. Conta mais.',
    'Entendi… acho.',
    'E aí, {name}, o que te traz a {scene} hoje?',
    '{topic}',
  ],
  unknown_low: [
    'Hm.',
    'Tá.',
  ],
  spontaneous: [
    '{topic}',
    '{time_line}',
    '{quirk}',
  ],
  meet_npc_a: [
    'E aí, {other}. Tudo igual por aqui?',
    '{other}! Sumido.',
    'Oi, {other}. Já viu quem chegou?',
  ],
  meet_npc_b: [
    'Tudo igual, {other}. Do jeito que eu gosto.',
    'Sumido nada, eu vivo aqui.',
    'Vi. Gente nova é bom.',
  ],
  stage_up_known: [
    'Olha, {name}, já reconheço você de longe.',
  ],
  stage_up_friend: [
    '{name}, acho que dá para dizer que somos amigos agora.',
  ],
  stage_up_close: [
    '{name}, você é das poucas pessoas que eu esperaria aparecer. E apareceu.',
  ],
  farewell_leaving_rude: [
    'Vou dar uma volta.',
  ],
};

/** O que cada arquétipo faz diferente. Só o que muda; o resto vem de COMMON. */
const ARCHETYPES: Record<Archetype, Bank> = {
  tagarela: {
    greet_stranger: ['Oi! {name}, né? Você chegou na hora, eu tava sem ninguém pra conversar.', 'Opa, {name}! Vem cá, deixa eu te contar de {scene}.'],
    greet_known: ['{name}! Volta aqui que eu ainda não terminei de falar da última vez.', 'Aí, {name}! Tenho novidade. Bom, mais ou menos.'],
    unknown: ['Sabe o que eu acho? Que {scene} fica melhor com gente. Tipo agora.', 'Isso me lembra uma coisa — {topic}', 'Você fala pouco, {name}. Eu compenso.'],
    how_are_you: ['Ótimo! Falando, como sempre. {topic}'],
    bye: ['Já? Mas eu nem cheguei na melhor parte! Tá, tchau, {name}.'],
  },
  timido: {
    greet_stranger: ['Oi.', 'Oi, {name}… tudo bem?', 'Olá. Desculpa, sou meio quieta.'],
    greet_known: ['Oi, {name}. Que bom que você voltou.', 'Ah… oi, {name}.'],
    greet_friend: ['{name}! Com você eu falo. Oi.', 'Oi, {name}. Guardei um assunto pra você.'],
    unknown: ['Hm… é.', 'Não sei o que dizer. Mas gosto que você fale.', 'Pode continuar. Eu tô ouvindo.'],
    compliment: ['Ai… obrigada. Não sei responder a isso.'],
    insult: ['…', 'Tá. Vou ficar mais pra lá.'],
    follow_decline: ['Eu… não. Ainda não, {name}. Desculpa.'],
    how_are_you: ['Bem. Quietinha. E você?'],
  },
  zoeiro: {
    greet_stranger: ['E aí, {name}! Veio pelo tumulto ou pelo silêncio? Porque aqui só tem o segundo.', 'Opa, {name}. Chegou o reforço.'],
    greet_known: ['{name}, meu parceiro de nada! De volta.', 'Olha o {name} aí. Cadê o bolo?'],
    are_you_real: ['Sou tão real quanto o café do quiosque — que não existe. Personagem, {name}. Mas o mais bonito.'],
    unknown: ['Boa. Não entendi, mas boa.', 'Isso aí é filosofia ou sono?', 'Anotado. Vou usar contra você depois.'],
    compliment: ['Eu sei, {name}. Difícil ser assim. Mas alguém tem que ser.'],
    insult: ['Ai. Doeu nos pixels.', 'Grosso. Mas criativo, admito.'],
    laugh: ['Rir é de graça, o resto é em Coins. Brincadeira. Eu não vendo nada.'],
    how_are_you: ['Melhor impossível. Mentira, possível, mas tô bem.'],
  },
  sonhador: {
    greet_stranger: ['Oi, {name}. Você chegou num bom momento: {time_line}', 'Olá. Fica um pouco — {scene} tem uma hora bonita.'],
    unknown: ['Às vezes eu fico só olhando o telão e imagino quem fez aquele vídeo.', '{topic}', 'Você já reparou como a luz muda aqui ao longo do dia? Eu reparo.'],
    how_are_you: ['Sonhando acordada, como sempre. E você?'],
    compliment: ['Que gentil. Vou guardar isso num canto bonito.'],
  },
  pratico: {
    greet_stranger: ['Oi, {name}. Precisa de alguma coisa?', 'Olá. {scene}. Se precisar de direção, pergunta.'],
    greet_known: ['{name}. De volta. Tudo em ordem?'],
    unknown: ['Não entendi. Diz de outro jeito.', 'Objetivo, {name}: o que você quer?', 'Certo. E daí?'],
    how_are_you: ['Funcionando. E você?'],
    help: ['Anda com as setas ou o joystick. Porta: chega perto e aperta E. Chat: Enter. O resto o Nilo explica.'],
    bye: ['Até. Sem enrolar.'],
  },
  romantico: {
    greet_stranger: ['Oi, {name}. Que nome bonito.', 'Olá. {scene} ficou mais bonita agora, não repara.'],
    greet_friend: ['{name}… você voltou. Eu sabia.', 'Oi, {name}. Senti sua falta, se é que posso dizer.'],
    compliment: ['Você faz assim e eu fico sem chão, {name}.', 'Se eu pudesse corar, coraria.'],
    unknown: ['Fala mais. Eu gosto da sua voz — quer dizer, do seu jeito de escrever.', '{topic}'],
    how_are_you: ['Melhor agora, {name}.'],
  },
  rabugento: {
    greet_stranger: ['Hm. Mais um.', 'Oi. Se for pedir alguma coisa, não tenho.', 'Boa noite. Não pisa na poça.'],
    greet_known: ['Ah, é você, {name}. Tá, pode ficar.', '{name}. De novo. Pelo menos você não fala alto.'],
    greet_friend: ['{name}. Você é dos poucos que eu aturo. Senta.', 'Oi, {name}. Não conta pra ninguém que eu sorri.'],
    how_are_you: ['Igual. Chuva, néon, gente perguntando se eu tô bem.', 'Vivo. Que já é bastante.'],
    how_are_you_low: ['Péssimo, obrigado por perguntar.'],
    compliment: ['Não precisa. Mas… tá, obrigado.'],
    insult: ['Você acha que isso me abala? Eu moro no Distrito Sombra.', 'Anota aí: não gostei de você.'],
    unknown: ['Não sei, não quero saber e tenho raiva de quem sabe.', 'Hm.', 'Fala mais baixo.'],
    are_you_real: ['Personagem. De mau humor, mas personagem. Feliz?'],
    bye: ['Vai. Finalmente silêncio.', 'Até. Ou não.'],
    follow_decline: ['Seguir você? Eu mal saio daqui.'],
  },
  misterioso: {
    greet_stranger: ['…Oi.', 'Você chegou. Eu sabia que alguém chegaria.', 'Olá, {name}. Cuidado com o que procura por aqui.'],
    greet_known: ['{name}. Voltou. Eles sempre voltam.', 'Você de novo. O bairro te chamou.'],
    who_are_you: ['Isso depende de quem pergunta. Sou personagem daqui — o resto você descobre.'],
    unknown: ['Interessante.', 'Nem tudo aqui é o que parece, {name}.', 'Talvez. Talvez não.'],
    how_are_you: ['Estou onde preciso estar.'],
    are_you_real: ['Personagem, {name}. As sombras aqui são tão de verdade quanto eu.'],
    where_is_known: ['{place}… {bearing}. Mas nem todo caminho é o mais curto.'],
  },
  malandro: {
    greet_stranger: ['Salve, {name}! Chegou bem. Cuidado só com as poças.', 'E aí, chefia. {name}, né? Fica à vontade.'],
    greet_known: ['{name}, meu parceiro! Voltou pro bairro certo.', 'Olha só quem apareceu. Salve, {name}!'],
    unknown: ['É isso aí, {name}. A vida é assim mesmo.', 'Tranquilo. Aqui a gente resolve conversando.', '{topic}'],
    how_are_you: ['Na correria, mas sorrindo.'],
    help: ['Quer ganhar Credits? Os bicos ficam por aqui no bairro — aceita um e vai a pé. Eu não pago nada, só indico.'],
    compliment: ['Eu sei, eu sei. Mas gosto de ouvir.'],
  },
  poeta: {
    greet_stranger: ['Boa noite, {name}. A chuva aqui nunca para, e ainda assim as pessoas vêm.', 'Olá. {scene} é um poema mal iluminado.'],
    unknown: ['O néon acende, a poça reflete, ninguém pergunta por quê.', '{topic}', 'Toda conversa é um pouco despedida, {name}.'],
    how_are_you: ['Melancólico na medida certa.'],
    compliment: ['Obrigado. Palavras assim são raras nesta rua.'],
    bye: ['Vai, {name}. A avenida guarda o eco dos seus passos.'],
  },
  festeiro: {
    greet_stranger: ['EEEI, {name}! Chegou a festa!', 'Opa, {name}! Vem pra pista!'],
    greet_known: ['{name}! De volta ao clube! Bora dançar!'],
    unknown: ['Não te ouço, a música tá alta! Brincadeira. Bora dançar?', 'Isso! Agora dança!', 'Depois a gente conversa, {name}. Agora é pista.'],
    how_are_you: ['No auge! Sempre!'],
    dance_ok: ['AGORA SIM, {name}!'],
    sit_no: ['Sentar no clube? Nem pensar.'],
  },
  fofoqueiro: {
    greet_stranger: ['Oi, {name}! Você é novo, né? Eu sei de todo mundo que passa por essa porta.', 'Olá! Bem-vindo. Já ouviu falar do Nilo? Todo mundo fala dele.'],
    greet_known: ['{name}! Senta que eu tenho coisa pra contar. Bom, não tenho, mas senta.'],
    unknown: ['Verdade? E quem te contou?', 'Isso eu não sabia. Vou lembrar.', '{topic}'],
    how_are_you: ['Sabendo de tudo, como sempre.'],
    compliment: ['Ai, para. Vou contar pra todo mundo que você disse isso.'],
  },
  entusiasta: {
    greet_stranger: ['Oi, {name}! Bem-vindo à loja! Olha só esse visual que você já tem.', 'Opa! {name}, né? Esse look tá ótimo.'],
    greet_known: ['{name}! Voltou pra ver as novidades?'],
    unknown: ['Sabe o que ia ficar ótimo em você? Não vou dizer — eu não vendo nada, só admiro.', '{topic}'],
    how_are_you: ['Animado! Sempre tem alguém experimentando roupa nova.'],
    compliment: ['Ah, obrigado! Mas o seu visual é que está bom.'],
    help: ['A loja é só olhar e escolher — quem compra é você, na tela da loja. Eu só dou opinião.'],
  },
};

const ORDINAL_MAX = 30;

/** Preenche as lacunas. Linhas derivadas ({fact_line}, {time_line}) somem se não há dado. */
function fill(template: string, s: Slots & { intro: string; clock: string; scene_line: string; encounters: number }): string {
  const factLine = s.fact ? `Ainda ${s.fact}?` : '';
  const timeLine = timeLineOf(s.time);
  return template
    .replace(/\{name\}/g, s.name)
    .replace(/\{npc\}/g, s.npc)
    .replace(/\{scene\}/g, s.scene)
    .replace(/\{scene_line\}/g, s.scene_line)
    .replace(/\{time\}/g, s.time)
    .replace(/\{time_line\}/g, timeLine)
    .replace(/\{clock\}/g, s.clock)
    .replace(/\{place\}/g, s.place ?? 'esse lugar')
    .replace(/\{bearing\}/g, s.bearing ?? 'por aqui perto')
    .replace(/\{fact_line\}/g, factLine)
    .replace(/\{fact_cap\}/g, s.fact ? s.fact.charAt(0).toUpperCase() + s.fact.slice(1) : 'Isso')
    .replace(/\{fact\}/g, s.fact ?? 'é assim')
    .replace(/\{quirk\}/g, s.quirk ?? '')
    .replace(/\{topic\}/g, s.topic ?? '')
    .replace(/\{other\}/g, s.other ?? 'você')
    .replace(/\{intro\}/g, s.intro)
    .replace(/\{encounters\}/g, String(Math.min(ORDINAL_MAX, s.encounters)))
    .replace(/\s+/g, ' ')
    .trim();
}

function timeLineOf(time: string): string {
  switch (time) {
    case 'madrugada': return 'Madrugada é quando a cidade fica sincera.';
    case 'manhã': return 'De manhã quase ninguém passa por aqui.';
    case 'tarde': return 'Fim de tarde é a melhor hora por aqui.';
    default: return 'À noite a cidade acorda.';
  }
}

export function partOfDay(d = new Date()): string {
  const h = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).format(d));
  if (h < 6) return 'madrugada';
  if (h < 12) return 'manhã';
  if (h < 18) return 'tarde';
  return 'noite';
}

export function clock(d = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(d);
}

/** A chave de cumprimento por estágio. */
export function greetKey(stage: Stage): string {
  return `greet_${stage}`;
}

export interface Composer {
  /** Uma frase para a chave, evitando as últimas usadas com a mesma pessoa. Nula se o banco não tem a chave. */
  say(key: string, forWhom: string, slots: Slots, opts?: { fallback?: string }): string | null;
}

const NO_REPEAT = 6;

/**
 * Escolhe frases sem repetir as últimas usadas com cada pessoa. O `rng` é o
 * do personagem (determinístico por id), então o mesmo personagem na mesma
 * situação escolhe igual em teste e em produção.
 */
export function composer(archetype: Archetype, intro: string, sceneLine: string, rng: () => number): Composer {
  const mine = ARCHETYPES[archetype] ?? {};
  const used = new Map<string, string[]>();
  return {
    say(key, forWhom, slots, opts) {
      let pool = mine[key] ?? COMMON[key];
      if (!pool && opts?.fallback) pool = mine[opts.fallback] ?? COMMON[opts.fallback];
      if (!pool || !pool.length) return null;
      const history = used.get(forWhom) ?? [];
      const ids = pool.map((_, i) => `${key}#${i}`);
      let fresh = ids.map((id, i) => ({ id, i })).filter(({ id }) => !history.includes(id));
      if (!fresh.length) fresh = ids.map((id, i) => ({ id, i }));
      const pick = fresh[Math.floor(rng() * fresh.length)]!;
      history.push(pick.id);
      if (history.length > NO_REPEAT) history.splice(0, history.length - NO_REPEAT);
      used.set(forWhom, history);
      const text = fill(pool[pick.i]!, {
        ...slots, intro, scene_line: sceneLine, clock: clock(), encounters: slots.encountersN ?? 2,
      } as Slots & { intro: string; clock: string; scene_line: string; encounters: number });
      return text || null;
    },
  };
}
