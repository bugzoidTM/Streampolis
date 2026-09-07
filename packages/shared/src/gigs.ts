/**
 * Bicos de rua (PRD §26).
 *
 * O §26 lista quatro trabalhos no MVP — atendente, **entregas virtuais**,
 * tarefas diárias e **pequenos gigs** — e termina com a frase que justifica a
 * seção: "isso permite que uma pessoa prospere sem obrigatoriamente se tornar
 * streamer". Só as tarefas diárias existiam. As outras três foram adiadas com
 * um motivo escrito: *pedem mundo que ainda não existe — balcão com NPC, rota
 * de entrega, alguém para contratar*.
 *
 * O Distrito Sombra é essa rota. Um bico é uma sequência de PARADAS na rua, na
 * ordem, dentro de um tempo — e o que ele exige do jogador é a única coisa que
 * o jogo sempre soube fazer: andar até um lugar.
 *
 * ## As paradas não moram aqui, e este arquivo não importa ninguém
 *
 * As coordenadas são `NOIR.stops`, no mesmo arquivo em que estão as fachadas e
 * os postes. Uma lista de endereços escrita no catálogo de bicos e outra na
 * planta divergiriam na primeira vez que alguém mexesse numa fachada — e o
 * sintoma seria uma entrega cuja porta é uma parede.
 *
 * Aqui ficam só as CHAVES delas, e o arquivo não tem nenhum `import` de valor.
 * Isso não é asseio: a API roda TypeScript direto no Node, sem compilar, e por
 * isso alcança o pacote compartilhado por caminho relativo com extensão `.ts`
 * (ver `api/src/shared.ts`). Um módulo compartilhado que importe VALOR de outro
 * pelo especificador `./x.js` não resolve nesse modo — o serviço morre no boot.
 * Quem precisa juntar a chave à coordenada faz isso do seu lado, com o `NOIR`
 * que já tem em mãos.
 *
 * ## Quem decide que alguém CHEGOU
 *
 * O game server, e só ele: posição é dele (SPECs §21). A API não sabe onde
 * ninguém está e não deve saber. Ela recebe "fulano chegou na parada 2 do bico
 * X", confere que é a parada seguinte daquela corrida e que a corrida é dele,
 * e paga na última. O navegador não é autoridade sobre nenhum dos dois lados.
 *
 * ## Por que a recompensa é modesta
 *
 * A mediana da loja é 300 Credits. O bico mais curto paga 55 e leva menos de um
 * minuto; o mais longo paga 190. Um bico bom rende mais por minuto que uma
 * tarefa diária — é atividade, não presença —, e mesmo assim ninguém compra o
 * item mais caro numa tarde. O §26 fala em prosperar sem transmitir, não em
 * prosperar sem jogar.
 */

export interface GigStop {
  /** Chave em `NOIR.stops`. */
  id: string;
  /** O que a tela diz quando esta é a parada da vez. */
  hint: string;
}

export interface GigDef {
  id: string;
  title: string;
  /** A história do bico, em uma linha. É o que separa uma rota de um recado. */
  flavor: string;
  /** Onde ele acontece. Hoje só há um bairro; o campo evita presumir isso. */
  scene: 'noir_district';
  stops: GigStop[];
  /** Segundos para cumprir a rota inteira, no nível de atenção zero. */
  seconds: number;
  /** Pagamento base em Credits, no nível de atenção zero. */
  credits: number;
}

/**
 * O nível de ATENÇÃO, e a razão de ele não ser uma coluna.
 *
 * Quanto mais entregas alguém fecha no bairro em pouco tempo, mais o bairro
 * repara nele. Isso podia ser um contador com decaimento por relógio — e seria
 * a mesma armadilha que o §9 proíbe nas necessidades: quem some por dois dias
 * voltaria devendo. Aqui a atenção é DERIVADA dos fatos, como a fama e as
 * necessidades: é uma função das corridas fechadas nas últimas horas. Não
 * existe linha para zerar, não existe rotina para decair, e quem passa uma
 * semana fora volta no nível zero sem ter sido punido por nada.
 *
 * E ela não pune de forma nenhuma, em nenhum nível: paga MAIS e dá MENOS
 * tempo. Subir é uma escolha entre pagamento e folga, que é o que o §9 chama de
 * "criar decisões".
 */
export const HEAT_MAX = 5;

/** Janela em que uma corrida fechada ainda conta para a atenção. */
export const HEAT_WINDOW_HOURS = 6;

/** Corridas fechadas na janela para chegar a cada nível, do 1 ao 5. */
export const HEAT_STEPS: readonly number[] = [2, 4, 7, 11, 16];

/** O nível de atenção que tantas corridas na janela produzem. */
export function heatLevel(runsInWindow: number): number {
  let nivel = 0;
  for (const passo of HEAT_STEPS) if (runsInWindow >= passo) nivel++;
  return Math.min(nivel, HEAT_MAX);
}

/**
 * O bônus de pagamento do nível: +14% por estrela, até +70%.
 *
 * Vale a pena subir, e não tanto que não subir seja errado — o teto é menos que
 * o dobro. Uma escada em que o topo paga três vezes mais transforma "escolher"
 * em "obedecer".
 */
export function heatPayout(base: number, level: number): number {
  return Math.round(base * (1 + 0.14 * level));
}

/**
 * O aperto do tempo: −6% por estrela, até −30%.
 *
 * É o outro lado do bônus, e é onde a atenção vira dificuldade em vez de
 * castigo: a rota é a mesma, o pagamento é maior, o relógio é mais curto. Quem
 * não quer o aperto para de correr por algumas horas e o nível cai sozinho.
 */
export function heatSeconds(base: number, level: number): number {
  return Math.round(base * (1 - 0.06 * level));
}

export const GIGS: readonly GigDef[] = [
  {
    id: 'entrega_expressa',
    title: 'Entrega expressa',
    flavor: 'Um pacote do café até a portaria do hotel. Ninguém pergunta o que tem dentro.',
    scene: 'noir_district',
    stops: [
      { id: 'cafe', hint: 'Pegue o pacote no café da avenida.' },
      { id: 'hotel', hint: 'Deixe na portaria do hotel.' },
    ],
    seconds: 75,
    credits: 55,
  },
  {
    id: 'ronda_dos_letreiros',
    title: 'Ronda dos letreiros',
    flavor: 'O dono de três fachadas quer saber quais lâmpadas queimaram. A pé, uma por uma.',
    scene: 'noir_district',
    stops: [
      { id: 'bar', hint: 'Confira o letreiro do bar da esquina.' },
      { id: 'club', hint: 'Agora o do clube, do outro lado da avenida.' },
      { id: 'loja', hint: 'E o da loja de conveniência, no fim da rua.' },
    ],
    seconds: 135,
    credits: 105,
  },
  {
    id: 'carga_da_doca',
    title: 'Carga da doca',
    flavor: 'Descarregar na doca e levar o resto para a oficina antes que o turno vire.',
    scene: 'noir_district',
    stops: [
      { id: 'doca', hint: 'Assuma a carga na doca.' },
      { id: 'oficina', hint: 'Entregue na oficina.' },
      { id: 'metro', hint: 'Devolva o carrinho na boca do metrô.' },
    ],
    seconds: 150,
    credits: 120,
  },
  {
    id: 'recado_do_beco',
    title: 'Recado do beco',
    flavor: 'Alguém espera junto ao tambor aceso. Leve a resposta ao bar e não olhe para trás.',
    scene: 'noir_district',
    stops: [
      { id: 'fundos', hint: 'Vá até o fundo do beco, onde o tambor está aceso.' },
      { id: 'bar', hint: 'Leve a resposta ao bar da esquina.' },
      { id: 'portao', hint: 'Suma pelo portão do bairro.' },
    ],
    seconds: 165,
    credits: 145,
  },
  {
    id: 'volta_completa',
    title: 'Volta completa',
    flavor: 'A avenida inteira, ponta a ponta, com passagem pelo beco. Quem aguenta, ganha.',
    scene: 'noir_district',
    stops: [
      { id: 'metro', hint: 'Comece na boca do metrô.' },
      { id: 'loja', hint: 'Atravesse até a loja, no extremo leste.' },
      { id: 'fundos', hint: 'Corte pelo beco até o fundo.' },
      { id: 'bar', hint: 'Termine no bar da esquina.' },
    ],
    seconds: 235,
    credits: 190,
  },
];

export const GIG_BY_ID = new Map(GIGS.map((g) => [g.id, g]));

/**
 * Raio de chegada numa parada, em metros.
 *
 * Generoso de propósito. A posição que o jogador VÊ é a do preditor do cliente
 * e oscila em torno da que o servidor tem; um raio apertado transforma "chegar"
 * em "acertar", e o sintoma é o pior possível — o jogador está em pé no lugar
 * certo e o jogo não concorda.
 */
export const GIG_STOP_RADIUS = 2.6;
