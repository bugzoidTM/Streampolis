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
// Bicos de rua (§26) e a planta do bairro onde eles acontecem. `gigs.ts` não
// importa ninguém de propósito, e `layout.ts` também não — as duas condições
// que fazem este caminho relativo funcionar no modo sem compilação.
export * from '../../shared/src/gigs.ts';
export { NOIR } from '../../shared/src/layout.ts';
export { HOME_BOUNDS } from '../../shared/src/interiors.ts';
export { ITEM_CATALOG, BODY_ITEM } from '../../shared/src/items.ts';
export type { ItemDef, ItemType } from '../../shared/src/items.ts';
// Moderação de texto (§27): a MESMA lista que o chat usa no game server. Uma
// segunda lista aqui ensinaria onde escrever o que não se pode.
export {
  checkName, hasBannedTerm, nameRejectionMessage, normaliseText, sanitizeLiveTitle,
  DEFAULT_TERMS, RESERVED_NAMES, NEUTRAL_LIVE_TITLE,
} from '../../shared/src/moderation.ts';
