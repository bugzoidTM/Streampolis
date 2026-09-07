/**
 * Texto que outras pessoas vão ler (PRD §27, SPECs §39).
 *
 * O §27 lista dez recursos obrigatórios de segurança social, e três deles são
 * sobre TEXTO: filtro de termos, moderação de usernames e moderação de títulos
 * de live. O filtro existia — mas só no chat, dentro do game server, com a
 * lista trancada lá. Username e título de live passavam direto.
 *
 * Isto é o que faltava: uma normalização e uma lista, num lugar que os dois
 * lados alcançam. Ter duas listas seria pior do que ter uma incompleta — a
 * palavra proibida no chat e permitida no nome do perfil ensina exatamente onde
 * escrever o que não se pode.
 *
 * ## Onde cada texto é conferido, e por que é diferente
 *
 *   * **chat**: mascara e deixa passar. Interromper a conversa por uma palavra
 *     é pior para a sala do que a palavra;
 *   * **username**: RECUSA no cadastro. Ele é permanente, aparece em cima da
 *     cabeça da pessoa na praça e não dá para "mascarar" um nome;
 *   * **título de live**: é trocado por um neutro, e o host é avisado. Ele vai
 *     para o feed público — a vitrine do produto — e derrubar a live inteira
 *     por causa do título seria punição desproporcional.
 */

/**
 * Lista base pt-BR, guardada como RADICAIS. Pequena de propósito: a lista de
 * verdade é serviço de moderação (SPECs §39/§40), e isto existe para o óbvio
 * não chegar à tela de ninguém enquanto ele não existe.
 */
export const DEFAULT_TERMS: readonly string[] = [
  'porra', 'caralho', 'merda', 'buceta', 'foder', 'fodase',
  'puta', 'viado', 'arrombado', 'cuzao', 'desgraca', 'vadia',
];

/**
 * Nomes que ninguém pode usar porque eles MENTEM sobre quem a pessoa é.
 *
 * Não é lista de palavrão: é impersonação. Um jogador chamado "moderador" ou
 * "suporte" consegue, só com o nome, pedir a senha de alguém na praça — e o
 * jogo teria ensinado essa pessoa a confiar nele.
 */
export const RESERVED_NAMES: readonly string[] = [
  'admin', 'administrador', 'moderador', 'moderator', 'mod', 'staff', 'suporte',
  'support', 'streampolis', 'sistema', 'system', 'oficial', 'official', 'root',
  'atendimento', 'seguranca', 'security',
];
// "ajuda" e "help" saíram da lista: um teste mostrou que "ajudante" — nome
// perfeitamente inocente — era recusado por conter "ajuda". Palavra genérica
// impersona pouco e atropela muito; a lista é sobre quem se passa pela EQUIPE.

const LEET = new Map<string, string>([
  ['0', 'o'], ['1', 'i'], ['3', 'e'], ['4', 'a'], ['5', 's'], ['7', 't'], ['@', 'a'], ['$', 's'],
]);

/**
 * Tira acento, leetspeak e letra repetida, para "p0rrrra" continuar batendo.
 *
 * Repetição colapsa para UM caractere, não dois: "m3rrrda" precisa chegar em
 * "merda" ou o radical nunca casa. A lista passa pela mesma função, então um
 * dobrado legítimo ("carro") é comparado contra um radical igualmente colapsado
 * e nada novo começa a casar.
 */
export function normaliseText(text: string): string {
  const flat = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  let out = '';
  for (const ch of flat) out += LEET.get(ch) ?? ch;
  return out.replace(/(.)\1+/g, '$1').replace(/[^a-z0-9\s]/g, '');
}

/** Os radicais já normalizados — o formato que as comparações usam. */
export function normalisedTerms(terms: readonly string[] = DEFAULT_TERMS): string[] {
  return terms.map((t) => normaliseText(t)).filter(Boolean);
}

/**
 * Tem termo proibido?
 *
 * Compara sem separar por palavra de propósito: "seuviado" e "vi ado" são a
 * mesma tentativa, e quem escreve assim sabe que está tentando.
 *
 * **Limitação conhecida**: casa por SUBSTRING do radical, então derivadas que
 * não contêm o radical inteiro escapam ("merdinha" não contém "merda"). Está
 * coberto por teste — como lacuna declarada, não como descuido. Encurtar os
 * radicais pegaria as derivadas e começaria a recusar palavra inocente, que num
 * nome permanente é o erro mais caro dos dois. A saída certa é a lista virar
 * serviço de moderação com severidade (SPECs §39/§40).
 */
export function hasBannedTerm(text: string, terms: readonly string[] = DEFAULT_TERMS): boolean {
  const alvo = normaliseText(text).replace(/\s+/g, '');
  if (!alvo) return false;
  return normalisedTerms(terms).some((t) => alvo.includes(t));
}

export type NameRejection = 'termo' | 'reservado' | null;

/**
 * A partir de quantas letras um nome reservado casa por CONTÉM.
 *
 * "moderador_oficial" mente tanto quanto "moderador", então nome longo casa por
 * substring. Nome curto, não: "mod" dentro de "modelo" e "modesto" recusaria
 * gente inocente, e recusar um nome que ninguém ia estranhar é o pior lado de
 * errar aqui — a pessoa nem entende o motivo. Curto casa por IGUALDADE.
 */
const CONTEM_A_PARTIR_DE = 5;

/**
 * Este nome pode existir na cidade?
 */
export function checkName(name: string): NameRejection {
  const limpo = normaliseText(name).replace(/\s+/g, '');
  if (!limpo) return null;
  if (hasBannedTerm(name)) return 'termo';
  const reservado = RESERVED_NAMES.some((r) => {
    const alvo = normaliseText(r);
    return alvo.length >= CONTEM_A_PARTIR_DE ? limpo.includes(alvo) : limpo === alvo;
  });
  return reservado ? 'reservado' : null;
}

/** O que dizer para quem escolheu um nome recusado. */
export function nameRejectionMessage(reason: Exclude<NameRejection, null>): string {
  return reason === 'termo'
    ? 'Este nome tem uma palavra que não pode aparecer na cidade. Escolha outro.'
    : 'Este nome pode ser confundido com a equipe do Streampolis. Escolha outro.';
}

/** Título de live: neutro quando o original não pode ir para o feed. */
export const NEUTRAL_LIVE_TITLE = 'Live';

export function sanitizeLiveTitle(raw: string): { title: string; replaced: boolean } {
  const limpo = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!limpo) return { title: NEUTRAL_LIVE_TITLE, replaced: false };
  if (hasBannedTerm(limpo)) return { title: NEUTRAL_LIVE_TITLE, replaced: true };
  return { title: limpo, replaced: false };
}
