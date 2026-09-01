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
 * A porta de saída de um interior, encostada na abertura sul.
 *
 * Todo interior tem uma: é por onde se entrou. Deduzir do `shell` em vez de
 * escrever a coordenada à mão é o que impede a porta de sair do lugar quando
 * alguém mudar o tamanho da sala — e mudanças de sala acontecem.
 */
const exitOf = (scene: SceneId, to: SceneId, label: string): Portal => {
  const shell = INTERIORS[scene]?.shell;
  const depth = shell?.depth ?? 18;
  return { id: `${scene}_exit`, to, label, x: 0, z: depth / 2 - 1.5, ry: 0, r: 2.2 };
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
    { id: 'lobby_home', to: 'home', label: 'Meu apartamento', x: 5.8, z: -8.2, ry: Math.PI, r: 2.2 },
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
