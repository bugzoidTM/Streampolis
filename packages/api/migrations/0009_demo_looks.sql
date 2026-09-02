-- A demonstração pública não pode abrir com três pessoas idênticas.
--
-- A tela de entrada de streampolis.nutef.com mostra ana, beto e caio, e o 0008
-- deixou os três com o MESMO conjunto: ele repara quem aponta para peça inativa
-- pondo o padrão, e o padrão é um só. Reparar era o certo — sem isso os três
-- entrariam sem roupa nenhuma —, mas o resultado é a primeira tela do produto
-- dizendo que dá no mesmo quem você escolhe.
--
-- Em desenvolvimento quem resolve é o `seed`, que é autoridade sobre as quatro
-- fixtures. Em produção o `seed` é proibido (lá só roda `mirror-catalog.ts`), e
-- por isso o mesmo conserto precisa vir por migração.
--
-- Escreve SÓ por cima do conjunto padrão: se alguém já vestiu essas contas pelo
-- criador de avatar, a escolha da pessoa fica. E confere `active` peça por
-- peça, para uma migração antiga não ressuscitar item que saiu do catálogo.

CREATE TEMP TABLE demo_look (username text PRIMARY KEY, look jsonb) ON COMMIT DROP;

INSERT INTO demo_look VALUES
  ('ana', '{"bodyPreset":2,"skinTone":3,"facePreset":1,"hairColor":4,"height":1.0,
            "hair":"f_suit_head","top":"f_suit_top",
            "bottom":"f_suit_bottom","shoes":"f_suit_shoes"}'::jsonb),
  ('beto', '{"bodyPreset":1,"skinTone":6,"facePreset":2,"hairColor":0,"height":1.05,
            "hair":"m_hoodie_character_head","top":"m_hoodie_character_top",
            "bottom":"m_worker_bottom","shoes":"m_casual_character_shoes"}'::jsonb),
  ('caio', '{"bodyPreset":3,"skinTone":1,"facePreset":3,"hairColor":2,"height":0.96,
            "hair":"m_business_man_head","top":"m_business_man_top",
            "bottom":"m_business_man_bottom","shoes":"m_business_man_shoes"}'::jsonb);

-- Vestir exige possuir (`AvatarService`): sem o inventário, a própria aparência
-- que esta migração escreve seria recusada na primeira troca de look.
INSERT INTO streampolis.inventory (user_id, item_id)
SELECT u.id, i.id
  FROM demo_look d
  JOIN streampolis.users u ON u.username = d.username
  JOIN streampolis.items i
    ON i.active
   AND i.id IN (d.look->>'hair', d.look->>'top', d.look->>'bottom', d.look->>'shoes')
ON CONFLICT (user_id, item_id) DO NOTHING;

UPDATE streampolis.avatars a
   SET config = a.config || d.look, updated_at = now()
  FROM demo_look d
  JOIN streampolis.users u ON u.username = d.username
 WHERE a.user_id = u.id
   -- Só quem ainda está no conjunto que o 0008 pôs. Quem se vestiu, mantém.
   AND a.config->>'hair' = 'm_casual_character_head'
   AND a.config->>'top' = 'm_casual_character_top'
   -- E só se as quatro peças existirem e estiverem ativas: uma migração não
   -- pode vestir ninguém com item que já saiu do catálogo.
   AND (SELECT count(*) FROM streampolis.items i
         WHERE i.active
           AND i.id IN (d.look->>'hair', d.look->>'top', d.look->>'bottom', d.look->>'shoes')) = 4;
