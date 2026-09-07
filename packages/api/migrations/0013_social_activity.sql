-- 0013_social_activity.sql — a North Star do produto (PRD §31, §32).
--
-- A métrica principal não é dinheiro: é **Weekly Socially Active Players** —
-- quem, na semana, teve ao menos uma interação significativa com outra pessoa
-- (live, chat, follow, amizade, gift, PK, visita, agência).
--
-- Metade dessas interações já deixa rastro em tabela própria (follows,
-- friendships, gift_events, pk_matches, stream_sessions). A outra metade não
-- deixa nenhum: chat não é persistido de propósito (§31 do SPEC: mensagem de
-- sala não é patrimônio) e visita a apartamento é um join de WebSocket.
--
-- Em vez de passar a gravar tudo, esta tabela guarda a MENOR coisa que responde
-- à pergunta: um dia, uma pessoa, um tipo de interação. Chat de mil mensagens
-- vira uma linha. É o que torna a North Star uma consulta barata e o custo de
-- escrita desprezível.
CREATE TABLE streampolis.social_activity (
  user_id  UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  day      DATE NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN
             ('live','chat','follow','friendship','gift','pk','visit','agency')),
  first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, kind)
);

-- A consulta da North Star é "quantas pessoas distintas na janela": o índice
-- por dia é o que a mantém barata quando a base crescer.
CREATE INDEX social_activity_day_idx ON streampolis.social_activity (day, kind);
