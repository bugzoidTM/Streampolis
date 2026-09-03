/**
 * Porta única para @streampolis/shared.
 *
 * O pacote compartilhado publica .ts cru e se reexporta com especificadores
 * `./x.js`. O Vite resolve isso no cliente e o game-server compila para o
 * próprio dist; a API, que roda TypeScript direto no Node, não resolve nem um
 * nem outro — `index.js` não existe em disco.
 *
 * Então ela entra pelos ARQUIVOS, por caminho relativo e com extensão `.ts`.
 * Isso só funciona para módulos cujas dependências entre si sejam de TIPO: o
 * Node apaga `import type` antes de resolver. Um módulo compartilhado que
 * passe a importar valor de outro precisa ser compilado antes de aparecer
 * aqui — e é por isso que esta porta é uma lista explícita e não um `export *`
 * do índice.
 */
export * from '../../shared/src/placeables.ts';
export { HOME_BOUNDS } from '../../shared/src/interiors.ts';
export { ITEM_CATALOG, BODY_ITEM } from '../../shared/src/items.ts';
export type { ItemDef, ItemType } from '../../shared/src/items.ts';
