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
 * A mediana da loja é 300 Credits. O bico mais curto paga 70 e leva 45
 * segundos; o mais longo paga 240 e atravessa as duas ruas. Um bico bom rende
 * mais por minuto que uma tarefa diária — é atividade, não presença —, e mesmo
 * assim ninguém compra o item mais caro numa tarde. O §26 fala em prosperar sem
 * transmitir, não em prosperar sem jogar.
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

/**
 * As rotas.
 *
 * ## Os números mudaram quando o bairro dobrou
 *
 * As distâncias vinham de uma rua de 68 m; hoje são duas ruas e 116 m de
 * avenida. Manter os prazos antigos teria deixado tudo folgado a ponto de a
 * rota virar um passeio com espera no fim — que era, honestamente, o que
 * acontecia: o bico mais curto dava 75 s para 32 m, ou seja 0,43 m/s.
 *
 * O prazo agora sai da MEDIDA da rota, a 1,9 m/s no nível de atenção zero.
 * Isso é 79% da velocidade de caminhada, e é o número que decide o desenho
 * inteiro do aperto:
 *
 *   * **no nível 0 dá para cumprir tudo andando**, com folga para errar o
 *     caminho uma vez. Ninguém é obrigado a correr para entregar;
 *   * **no nível 5 o relógio encolhe 30%** (`heatSeconds`) e a exigência sobe
 *     para ~2,5 m/s — acima dos 2,4 m/s da caminhada. A partir dali as rotas
 *     longas SÓ fecham correndo.
 *
 * É assim que correr virou parte do jogo em vez de uma tecla que existe: a
 * atenção paga mais, aperta o relógio, e a resposta ao aperto é a velocidade.
 *
 * ## O pagamento por metro CAI nas rotas longas
 *
 * De 1,19 Credits/m na mais curta a 0,90 na mais longa, de propósito. Com
 * pagamento linear a maratona seria sempre a escolha ótima e as outras seis
 * viravam enfeite; com ele decrescente, a rota longa continua rendendo mais no
 * total (é mais trabalho) sem ser a única que vale a pena. O teto de 240 fica
 * abaixo da mediana da loja (300) — o §26 fala em prosperar sem transmitir,
 * não em comprar o sofá caro numa corrida.
 */
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
    seconds: 45,
    credits: 70,
  },
  {
    id: 'ronda_dos_letreiros',
    title: 'Ronda dos letreiros',
    flavor: 'O dono de três fachadas quer saber quais lâmpadas queimaram. A pé, uma por uma.',
    scene: 'noir_district',
    stops: [
      { id: 'bar', hint: 'Confira o letreiro do bar da esquina.' },
      { id: 'club', hint: 'Agora o do clube, no meio da avenida.' },
      { id: 'loja', hint: 'E o da loja de conveniência, lá no leste.' },
    ],
    seconds: 62,
    credits: 110,
  },
  {
    id: 'turno_da_travessa',
    title: 'Turno da travessa',
    flavor: 'Três portas de serviço na rua de trás. Ninguém entrega ali de dia.',
    scene: 'noir_district',
    stops: [
      { id: 'deposito', hint: 'Comece no depósito, na travessa. Entre pela passagem oeste.' },
      { id: 'garagem', hint: 'Siga pela travessa até a garagem.' },
      { id: 'clinica', hint: 'Termine na clínica noturna, no fim da travessa.' },
    ],
    seconds: 70,
    credits: 125,
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
    seconds: 74,
    credits: 130,
  },
  {
    id: 'carga_da_doca',
    title: 'Carga da doca',
    flavor: 'Descarregar na doca e levar o resto para a oficina antes que o turno vire.',
    scene: 'noir_district',
    stops: [
      { id: 'doca', hint: 'Assuma a carga na doca.' },
      { id: 'oficina', hint: 'Entregue na oficina.' },
      { id: 'metro', hint: 'Devolva o carrinho na boca do metrô, no extremo oeste.' },
    ],
    seconds: 88,
    credits: 155,
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
    seconds: 110,
    credits: 190,
  },
  {
    id: 'ponta_a_ponta',
    title: 'Ponta a ponta',
    flavor: 'Do portão à lavanderia do fim da avenida, e ainda por cima da travessa. É a rota que ninguém aceita duas vezes seguidas.',
    scene: 'noir_district',
    stops: [
      { id: 'portao', hint: 'Assuma no portão do bairro.' },
      { id: 'lavanderia', hint: 'Atravesse a avenida inteira até a lavanderia 24h.' },
      { id: 'clinica', hint: 'Suba pela passagem leste e siga até a clínica.' },
      { id: 'fundos', hint: 'Volte pela travessa e desça no fundo do beco.' },
    ],
    seconds: 130,
    credits: 220,
  },
  {
    id: 'atalho_das_passagens',
    title: 'Atalho das passagens',
    flavor: 'Quem conhece o bairro não vai pela avenida. Duas passagens, duas ruas, um envelope.',
    scene: 'noir_district',
    stops: [
      { id: 'lavanderia', hint: 'Pegue o envelope na lavanderia 24h.' },
      { id: 'passagem_l', hint: 'Suba pela passagem leste.' },
      { id: 'garagem', hint: 'Deixe metade na garagem da travessa.' },
      { id: 'passagem_o', hint: 'Desça de volta pela passagem oeste.' },
      { id: 'bar', hint: 'O resto é do bar da esquina.' },
    ],
    seconds: 145,
    credits: 240,
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
