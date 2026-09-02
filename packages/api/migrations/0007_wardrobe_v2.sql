-- Guarda-roupa v2: o catálogo antigo deixou de existir.
--
-- As 45 peças procedurais (hair_bob_01, top_tee_01…) saíram do catálogo quando
-- o avatar passou a ser montado com peças de asset. Um avatar guardado ainda
-- aponta para elas, e apontar para item que não existe é o mesmo que não ter
-- roupa: a API recusa a peça desconhecida e o jogador entra pelado.
--
-- Quem tinha peça válida MANTÉM. Quem aponta para o que sumiu recebe o
-- conjunto padrão — é o que o jogador veria se criasse a conta hoje, e é
-- melhor do que um avatar sem calça.
UPDATE streampolis.avatars a
SET config = a.config || jsonb_build_object(
  'hair', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i WHERE i.id = a.config->>'hair' AND i.type = 'hair'
    ) THEN a.config->>'hair' ELSE 'm_casual_character_head' END,
  'top', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i WHERE i.id = a.config->>'top' AND i.type = 'top'
    ) THEN a.config->>'top' ELSE 'm_casual_character_top' END,
  'bottom', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i WHERE i.id = a.config->>'bottom' AND i.type = 'bottom'
    ) THEN a.config->>'bottom' ELSE 'm_casual_character_bottom' END,
  'shoes', CASE WHEN EXISTS (
      SELECT 1 FROM streampolis.items i WHERE i.id = a.config->>'shoes' AND i.type = 'shoes'
    ) THEN a.config->>'shoes' ELSE 'm_casual_character_shoes' END,
  -- O pacote não traz acessório avulso; o slot fica vazio até existir peça.
  'accessory', ''
);

-- E o inventário: vestir exige possuir. Todo mundo ganha o conjunto padrão,
-- senão a própria roupa que esta migração acabou de vestir seria recusada na
-- próxima troca de look.
INSERT INTO streampolis.inventory (user_id, item_id)
SELECT u.id, i.id
  FROM streampolis.users u
  CROSS JOIN streampolis.items i
 WHERE i.active AND i.credits_price = 0 AND i.type IN ('hair', 'top', 'bottom', 'shoes')
ON CONFLICT (user_id, item_id) DO NOTHING;
