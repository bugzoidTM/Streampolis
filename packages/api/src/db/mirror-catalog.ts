/**
 * Espelha `shared/items.ts` na tabela `items` — e só isso.
 *
 * Existe para a PRODUÇÃO. O `seed.ts` se recusa a rodar lá, e com razão: ele
 * cria contas de desenvolvimento com senha fixa e mexeria numa demo que está
 * no ar. Mas item novo no catálogo compartilhado precisa chegar ao banco de
 * qualquer jeito, ou a loja mostra o que a economia não conhece — defeito que
 * este projeto já pagou uma vez. Espelhar é idempotente.
 *
 *   docker exec -w /app/packages/api <sp-api> node src/db/mirror-catalog.ts
 */
import { mirrorCatalog } from './seed.ts';
import { closePool } from './pool.ts';

mirrorCatalog()
  .then((n) => console.log(`catálogo: ${n} itens espelhados de shared/items.ts`))
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('[catálogo] falhou:', err);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
