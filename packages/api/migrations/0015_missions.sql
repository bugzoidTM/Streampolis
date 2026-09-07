-- 0015_missions.sql — missões (PRD §24).
--
-- "Missões ajudam novos jogadores a entender o jogo." O PRD lista oito
-- exemplos, e a coisa mais importante sobre eles é que TODOS já acontecem: o
-- avatar já é gravado, a praça já publica presença, o follow já tem tabela, o
-- PK já vira linha no banco. Não falta nada para saber se a pessoa fez — falta
-- alguém perguntar, e uma recompensa do outro lado.
--
-- Por isso não existe tabela de "progresso de missão": o progresso é uma
-- CONSULTA sobre os fatos que o sistema já registra. Guardar progresso à parte
-- criaria uma segunda verdade que sai do lugar (o clássico: a pessoa fez a
-- live, o contador não subiu, e o suporte não tem como responder).
--
-- O que precisa ser guardado é só o que não dá para deduzir: se a recompensa
-- JÁ FOI PAGA. Isso é dinheiro, e dinheiro precisa de linha própria.
CREATE TABLE streampolis.mission_claims (
  user_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL,
  credits    INTEGER NOT NULL CHECK (credits >= 0),
  xp         INTEGER NOT NULL CHECK (xp >= 0),
  -- A transação que pagou. Sem ela, "recompensa paga" seria palavra nossa; com
  -- ela, o extrato do jogador e a missão contam a mesma história.
  tx_id      UUID REFERENCES streampolis.wallet_transactions(id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mission_id)
);
