-- 0010_rankings.sql — Rankings (PRD §23).
--
-- Por que uma TABELA de temporada e não uma constante: o PRD pede rankings
-- sazonais com um motivo declarado — "evitam que jogadores antigos dominem
-- permanentemente" —, e uma temporada que é uma constante no código não vira,
-- não tem nome e não pode ser consultada por quem já jogou. Com uma tabela, "a
-- temporada atual" é uma linha, virar a temporada é um INSERT, e o placar
-- antigo continua existindo para consulta em vez de desaparecer.
--
-- E por que os rankings NÃO saem de `player_stats`: aqueles contadores são
-- vitalícios. Somam desde sempre e não sabem responder "hoje" nem "nesta
-- temporada" — exatamente a pergunta que o PRD faz. Quem tem data é o evento
-- (`gift_events`, `pk_matches`), e é dele que o placar é somado.

CREATE TABLE streampolis.seasons (
  id        SMALLSERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at   TIMESTAMPTZ NOT NULL,
  CONSTRAINT season_window CHECK (ends_at > starts_at),
  -- Duas temporadas abertas ao mesmo tempo fariam "a temporada atual" ter duas
  -- respostas, e o placar da tela dependeria de qual linha o banco devolvesse
  -- primeiro. O banco recusa a sobreposição.
  EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&)
);

-- A primeira temporada começa no mês em que este banco nasce e dura 90 dias.
-- Não há nada de sagrado nos 90 dias; há em existir uma janela com fim, que é o
-- que impede o placar de virar um monumento a quem chegou primeiro.
--
-- O corte é no fuso do PÚBLICO, como o de "hoje" e o da "semana": em UTC a
-- temporada viraria às 21h de Brasília do dia anterior, e a tela diria "começou
-- em 1º de setembro" mostrando gifts do dia 31.
INSERT INTO streampolis.seasons (name, starts_at, ends_at)
SELECT 'Temporada 1', inicio, inicio + interval '90 days'
  FROM (SELECT date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')
               AT TIME ZONE 'America/Sao_Paulo' AS inicio) t;

-- Os índices que estes rankings pedem e que ninguém tinha pedido antes.
--
-- `gift_events` já era indexado por quem RECEBE (perfil e live) e por live. O
-- ranking pergunta duas coisas novas: por quem ENVIA (Top Gifters) e por
-- janela de tempo sobre todo mundo (todos os placares) — e essa segunda não é
-- servida por nenhum índice que comece pelo usuário.
CREATE INDEX gift_events_sender_idx ON streampolis.gift_events (sender_id, created_at DESC);
CREATE INDEX gift_events_created_idx ON streampolis.gift_events (created_at DESC);

-- PK só entra no placar quando termina, e partida terminada é uma fração das
-- linhas: o índice é parcial para não carregar as que ainda estão em jogo.
CREATE INDEX pk_matches_finished_idx ON streampolis.pk_matches (ended_at DESC)
  WHERE status = 'FINISHED';
