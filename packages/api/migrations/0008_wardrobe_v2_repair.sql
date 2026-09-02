-- O reparo do 0007, agora que "sair do catálogo" desativa o item.
--
-- O 0007 conferia se o item ainda existia na tabela `items` — e existia: o
-- espelhamento do catálogo só inseria e atualizava, nunca desativava o que
-- tinha saído. As 45 peças procedurais continuaram ativas no banco e nenhum
-- avatar foi reparado. Agora `mirrorCatalog` desativa o que não está mais em
-- `shared/items.ts`, e este arquivo refaz o reparo olhando para `active`.
--
-- Migração aplicada não se edita (o migrador confere checksum, e com razão):
-- por isso um arquivo novo em vez de um conserto no histórico.
UPDATE streampolis.avatars a
SET config = a.config || jsonb_build_object(
  'hair', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i
       WHERE i.id = a.config->>'hair' AND i.type = 'hair' AND i.active
    ) THEN a.config->>'hair' ELSE 'm_casual_character_head' END,
  'top', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i
       WHERE i.id = a.config->>'top' AND i.type = 'top' AND i.active
    ) THEN a.config->>'top' ELSE 'm_casual_character_top' END,
  'bottom', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i
       WHERE i.id = a.config->>'bottom' AND i.type = 'bottom' AND i.active
    ) THEN a.config->>'bottom' ELSE 'm_casual_character_bottom' END,
  'shoes', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i
       WHERE i.id = a.config->>'shoes' AND i.type = 'shoes' AND i.active
    ) THEN a.config->>'shoes' ELSE 'm_casual_character_shoes' END,
  'accessory', ''
);

INSERT INTO streampolis.inventory (user_id, item_id)
SELECT u.id, i.id
  FROM streampolis.users u
  CROSS JOIN streampolis.items i
 WHERE i.active AND i.credits_price = 0 AND i.type IN ('hair', 'top', 'bottom', 'shoes')
ON CONFLICT (user_id, item_id) DO NOTHING;
