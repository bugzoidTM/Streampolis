-- 0017_daily_tasks.sql — trabalhos (PRD §26), a parte que dá para fazer hoje.
--
-- "Além de lives, personagens poderão ganhar Credits realizando atividades.
-- MVP: atendente; entregas virtuais; TAREFAS DIÁRIAS; pequenos gigs. Isso
-- permite que uma pessoa prospere sem obrigatoriamente se tornar streamer."
--
-- Dos quatro, só "tarefas diárias" tem mecânica dedutível do que o jogo já é.
-- Atendente, entregas e gigs pedem mundo que não existe: balcão com NPC, rota
-- de entrega, alguém para contratar. Inventá-los aqui seria escrever produto
-- novo e chamar de "avançar o PRD" — eles ficam para quando o mundo tiver as
-- peças.
--
-- Como em `mission_claims`, o que se guarda é só o que não dá para deduzir: se
-- a recompensa daquele DIA foi paga. O cumprimento continua sendo consulta
-- sobre `social_activity` — a mesma tabela que já responde a North Star.
CREATE TABLE streampolis.daily_task_claims (
  user_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  task_id    TEXT NOT NULL,
  credits    INTEGER NOT NULL CHECK (credits >= 0),
  tx_id      UUID REFERENCES streampolis.wallet_transactions(id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, task_id)
);
