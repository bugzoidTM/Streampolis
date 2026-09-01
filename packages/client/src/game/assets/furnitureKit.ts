/**
 * Qual modelo do passe desenha cada `kind` de mobília.
 *
 * A divisão não é preguiça, é identidade: **a mobília vem do pacote, o
 * equipamento de live é autoral**. Sofá, cama, mesa e tapete são cenário — o
 * jogador reconhece um sofá em qualquer estilo, e um pacote bem desenhado faz
 * isso melhor do que um prop procedural nosso. Já a ring light, o microfone, o
 * monitor, o LED da parede e a bancada são o PRODUTO: é o que diferencia o
 * quarto de um streamer do quarto de qualquer um, e é o que ninguém vende
 * pronto na cara do Streampolis. Esses continuam desenhados aqui.
 *
 * `kind` que não aparece nesta tabela continua procedural. É por isso que a
 * troca é segura: a tabela é a única coisa que decide, e o layout, a colisão e
 * a loja não sabem que ela existe.
 */
export interface FurnitureModel {
  id: string;
  /** `stretch` só para o que é literalmente um retângulo. */
  fit?: 'uniform' | 'stretch';
  /** Metros a somar na altura de montagem — moldura de parede, por exemplo. */
  lift?: number;
}

export const FURNITURE_KIND: Record<string, FurnitureModel> = {
  sofa: { id: 'sofa' },
  armchair: { id: 'armchair' },
  coffee_table: { id: 'coffee_table' },
  desk: { id: 'desk' },
  table: { id: 'table' },
  // `shelf` fica procedural: o pacote gratuito não tem estante alta, e o
  // aparador baixo dele esticado para 1,90 m vira um móvel que não existe.
  // Um mapeamento errado é pior que nenhum — o procedural já estava certo.
  bed: { id: 'bed' },
  rug: { id: 'rug', fit: 'stretch' },
  pot_plant: { id: 'pot_plant' },
  plant_tall: { id: 'plant_tall' },
  floor_lamp: { id: 'floor_lamp' },
  wall_art: { id: 'wall_art' },
  trinkets: { id: 'books' },

  // Miudezas. Nenhuma delas existe no kit procedural, e é aí que um pacote
  // paga sozinho: ninguém vai modelar à mão uma pilha de livros, uma almofada
  // e um abajur de mesa, e é exatamente esse tipo de coisa que separa um
  // quarto mobiliado de um quarto habitado. Sem passe, estas peças
  // simplesmente não desenham — o quarto fica mais vazio, e é a verdade.
  books: { id: 'books' },
  pillow: { id: 'pillow' },
  table_lamp: { id: 'table_lamp' },
  frame: { id: 'wall_art_wide' },
  cabinet: { id: 'cabinet' },
};

/**
 * Variante por ITEM DA LOJA, quando o pacote oferece uma.
 *
 * Todo o KayKit compartilha UM atlas e, portanto, um material — que é por que
 * um quarto mobiliado por ele custa menos draw calls que o procedural, e
 * também por que a cor declarada em `PLACEABLES` não pode ser aplicada: tingir
 * o sofá tingiria os vinte e três móveis junto. A variedade que a cor dava
 * volta pela variedade do próprio pacote — dois sofás, duas poltronas, três
 * tapetes, duas camas.
 *
 * Consultado ANTES de {@link FURNITURE_KIND}; item sem entrada aqui cai no
 * modelo padrão do seu `kind`.
 */
export const FURNITURE_ITEM: Record<string, FurnitureModel> = {
  fur_sofa_01: { id: 'sofa' },
  fur_sofa_02: { id: 'sofa_plain' },
  fur_chair_01: { id: 'armchair' },
  fur_bed_01: { id: 'bed' },
  fur_rug_01: { id: 'rug', fit: 'stretch' },
  fur_rug_02: { id: 'rug_oval', fit: 'stretch' },
  fur_art_01: { id: 'wall_art' },
  fur_art_02: { id: 'wall_art_wide' },
};
