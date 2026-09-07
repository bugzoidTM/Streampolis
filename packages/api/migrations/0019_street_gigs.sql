-- 0019_street_gigs.sql — bicos de rua (PRD §26).
--
-- O §26 lista quatro trabalhos no MVP. A migration 0017 implementou um deles
-- (tarefas diárias) e escreveu o motivo de os outros três ficarem de fora:
-- "atendente, entregas e gigs pedem mundo que não existe: balcão com NPC, rota
-- de entrega, alguém para contratar. Eles ficam para quando o mundo tiver as
-- peças."
--
-- O Distrito Sombra é a rota. Esta migration é a parte de banco de "entregas
-- virtuais" e "pequenos gigs": uma corrida por vez, paradas em ordem, relógio.
--
-- ## O que se guarda, e o que NÃO se guarda
--
-- Guarda-se a corrida: quem, qual bico, quando começou, em que parada está,
-- quando terminou e quanto pagou. Nada disso é dedutível de outra tabela —
-- diferente das missões e das tarefas diárias, cujo cumprimento é uma consulta
-- sobre fatos que o jogo já registrava.
--
-- NÃO se guarda o nível de ATENÇÃO. Ele é uma função das corridas fechadas nas
-- últimas seis horas (ver `shared/gigs.ts`), e essa é a mesma escolha do §9
-- para as necessidades: um contador que decai por relógio pune quem esteve
-- fora, porque a pessoa volta devendo. Derivado dos fatos, quem passa uma
-- semana longe volta no nível zero sem que nada tenha acontecido com ela.
--
-- ## Uma corrida por vez, e a garantia é do banco
--
-- Aceitar dois bicos ao mesmo tempo é o caminho óbvio para ganhar duas vezes
-- andando uma vez só: as rotas se cruzam, e uma parada compartilhada contaria
-- para as duas. O índice parcial abaixo faz do banco a autoridade disso — não
-- um `if` na aplicação, que perde a corrida entre dois pedidos simultâneos.
CREATE TABLE streampolis.gig_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  gig_id       TEXT NOT NULL,
  -- O nível de atenção NO MOMENTO EM QUE A CORRIDA COMEÇOU.
  --
  -- Congelado aqui de propósito. O nível muda ao longo do dia, e ele decide o
  -- pagamento e o prazo: lido de novo na entrega, a corrida mudaria de regra no
  -- meio — inclusive encurtando um prazo que já estava correndo. O contrato é o
  -- do aceite.
  heat         SMALLINT NOT NULL CHECK (heat BETWEEN 0 AND 5),
  -- Quantas paradas já foram cumpridas. A próxima é sempre esta posição na
  -- lista do bico, e é isso que impede pular direto para a última.
  stops_done   SMALLINT NOT NULL DEFAULT 0 CHECK (stops_done >= 0),
  -- Prazo e pagamento acordados no aceite, já com o efeito da atenção.
  deadline_at  TIMESTAMPTZ NOT NULL,
  credits      INTEGER NOT NULL CHECK (credits >= 0),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quando a corrida saiu do ar: entregue, esgotada no relógio ou abandonada.
  ended_at     TIMESTAMPTZ,
  -- 'running' | 'delivered' | 'expired' | 'abandoned'
  outcome      TEXT NOT NULL DEFAULT 'running',
  -- A transação que pagou. Sem ela "entregue e pago" seria palavra nossa.
  tx_id        UUID REFERENCES streampolis.wallet_transactions(id),
  CHECK (outcome IN ('running', 'delivered', 'expired', 'abandoned')),
  -- Corrida encerrada tem data de fim; corrida em curso, não. Um estado que se
  -- contradiz é o que faz um relatório mentir seis meses depois.
  CHECK ((outcome = 'running') = (ended_at IS NULL))
);

-- Uma corrida em curso por pessoa. Índice parcial, não um `if` na aplicação:
-- dois pedidos de aceite simultâneos passariam pelo `if` os dois.
CREATE UNIQUE INDEX gig_runs_uma_por_vez
  ON streampolis.gig_runs (user_id) WHERE outcome = 'running';

-- A consulta do nível de atenção: "corridas entregues por esta pessoa desde tal
-- hora". É a leitura mais frequente do sistema — ela acontece a cada abertura
-- da tela e a cada aceite.
CREATE INDEX gig_runs_atencao
  ON streampolis.gig_runs (user_id, ended_at DESC) WHERE outcome = 'delivered';
