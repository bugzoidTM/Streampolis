import { INTERIORS } from './interiors.js';
import type { SceneId } from './types.js';

/**
 * As portas do mundo.
 *
 * O PRD §6 pede cinco coisas da Praça Central, e "acessar outros locais" era a
 * única sem nenhuma implementação: as salas existiam, as cenas existiam, e o
 * único jeito de ir de uma para a outra era editar a URL. Uma cidade cujos
 * lugares só se alcançam pela barra de endereço não é uma cidade.
 *
 * Ficam no pacote COMPARTILHADO pelo mesmo motivo de `placeables.ts`: hoje
 * quem lê é o cliente (desenha o marcador, mede a distância, oferece entrar),
 * mas a autorização de uma viagem é do servidor, e no dia em que ele precisar
 * recusar "entrei na loja estando a 40 m dela" a tabela já está do lado dele.
 */
export interface Portal {
  id: string;
  /**
   * Para onde leva. `'home'` é o apartamento de QUEM ENTROU — o destino não é
   * uma cena fixa, é uma pergunta que só a API sabe responder, e por isso ele
   * não é um `SceneId`.
   */
  to: SceneId | 'home';
  /** O que a placa diz. */
  label: string;
  x: number;
  z: number;
  /** Para onde o arco olha, em radianos. */
  ry: number;
  /** Raio de ativação, em metros. */
  r: number;
}

const TAU = Math.PI * 2;

/** Uma porta na praça, colocada a `radius` metros do centro num ângulo. */
const onPlaza = (id: string, to: SceneId, label: string, angle: number, radius = 22): Portal => ({
  id, to, label,
  x: Math.cos(angle) * radius,
  z: Math.sin(angle) * radius,
  // De costas para a borda: quem chega vê a frente do arco.
  ry: -angle + Math.PI / 2,
  r: 2.4,
});

/**
 * Raio de ativação de uma porta de interior.
 *
 * Menor que o da praça de propósito: lá fora 2,4 m é uma pisada em falso num
 * descampado, aqui dentro é um quarto inteiro. Uma porta que dispara de longe
 * num cômodo pequeno não é generosidade — é não conseguir andar perto da
 * parede sem o jogo perguntar se você quer sair.
 */
const INDOOR_R = 1.4;

/**
 * A porta de saída de um interior, encostada na abertura sul.
 *
 * Todo interior tem uma: é por onde se entrou. Deduzir do `shell` em vez de
 * escrever a coordenada à mão é o que impede a porta de sair do lugar quando
 * alguém mudar o tamanho da sala — e mudanças de sala acontecem.
 *
 * Deduzir a PROFUNDIDADE e chutar o X, porém, é meio caminho: a porta do
 * apartamento fica em `x = -2,2` e o arco era desenhado em `x = 0`, dois metros
 * ao lado dela, no meio da sala. Com raio de 2,2 m num estúdio de 7,2 × 8,4 a
 * zona de saída cobria metade do cômodo — e o ponto de CHEGADA caía dentro
 * dela. Quem entrava no próprio apartamento aparecia com "Sair" na tela e um
 * segundo `E` o mandava de volta; no saguão, onde a saída dá na praça, o mesmo
 * defeito devolvia à praça quem tinha ido buscar a própria casa.
 *
 * A porta é a abertura sul que chega ao CHÃO (`y === 0`). Uma janela também é
 * um buraco na parede, e não se sai por ela.
 */
const exitOf = (scene: SceneId, to: SceneId, label: string): Portal => {
  const shell = INTERIORS[scene]?.shell;
  const depth = shell?.depth ?? 18;
  const door = shell?.openings.find((o) => o.side === 'south' && o.y === 0);
  return { id: `${scene}_exit`, to, label, x: door?.x ?? 0, z: depth / 2 - 1.5, ry: 0, r: INDOOR_R };
};

export const PORTALS: Partial<Record<SceneId, Portal[]>> = {
  central_plaza: [
    onPlaza('plaza_store', 'stream_store', 'Stream Store', 0),
    onPlaza('plaza_tower', 'residential_lobby', 'Torre Residencial', TAU / 3),
    onPlaza('plaza_agency', 'agency_tower', 'Torre das Agências', (TAU * 2) / 3),
  ],

  stream_store: [exitOf('stream_store', 'central_plaza', 'Voltar à praça')],
  agency_tower: [exitOf('agency_tower', 'central_plaza', 'Voltar à praça')],

  residential_lobby: [
    exitOf('residential_lobby', 'central_plaza', 'Voltar à praça'),
    // Junto dos elevadores do saguão, que é onde uma pessoa procuraria.
    { id: 'lobby_home', to: 'home', label: 'Meu apartamento', x: 5.8, z: -8.2, ry: Math.PI, r: INDOOR_R },
  ],

  apartment: [exitOf('apartment', 'residential_lobby', 'Sair')],
};

/** A porta mais próxima de um ponto, se houver alguma ao alcance. */
export function portalNear(scene: SceneId, x: number, z: number): Portal | null {
  let best: Portal | null = null;
  let bestD = Infinity;
  for (const portal of PORTALS[scene] ?? []) {
    const d = Math.hypot(x - portal.x, z - portal.z);
    if (d <= portal.r && d < bestD) { best = portal; bestD = d; }
  }
  return best;
}
