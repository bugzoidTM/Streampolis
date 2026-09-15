-- 0028_npc_intention_result.sql — o resultado de uma intenção, em partes.
--
-- Até aqui o resultado era uma palavra ('done', 'expired'…) e um contador de
-- trocas de conversa. Não dizia se o personagem CHEGOU aonde queria, quanto
-- levou, quanto ficou lá, quem cruzou o caminho dele nem o que aconteceu no
-- mundo enquanto isso. Sem esses dados a próxima deliberação não sabe o que
-- foi novidade e o que foi tempo parado — e o "why" do modelo preenche o vazio
-- com inferência ("ninguém esteve aqui hoje"). Cada parte é uma coluna, para
-- o painel e o soak somarem por habilidade e por lugar.
ALTER TABLE streampolis.npc_intentions
  -- Chegou ao destino físico? NULL quando a habilidade não tem destino (wander, stay, follow…).
  ADD COLUMN IF NOT EXISTS arrived      BOOLEAN,
  -- Segundos do início até a (primeira) chegada.
  ADD COLUMN IF NOT EXISTS arrive_sec   INTEGER,
  -- Segundos da (primeira) chegada até o fim da intenção: quanto ficou no destino.
  ADD COLUMN IF NOT EXISTS dwell_sec    INTEGER,
  -- Interações com gente de verdade enquanto durou:
  -- {"exchanges": n, "greetings": n, "heard": n, "spokeWith": [nomes], "nearby": [nomes], "arrivals": n}
  ADD COLUMN IF NOT EXISTS interactions JSONB,
  -- O que aconteceu no mundo durante a intenção: [{"t": segundos desde o início, "what": "começou a chover"}]
  ADD COLUMN IF NOT EXISTS events       JSONB,
  -- A auditoria do "why": afirmações que trataram inferência como fato, sem dado correspondente.
  -- {"unsupported": ["o letreiro mudou"]}; NULL quando o why só afirmou o observado.
  ADD COLUMN IF NOT EXISTS why_audit    JSONB;
