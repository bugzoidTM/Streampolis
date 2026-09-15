-- 0026_npc_intentions.sql — a autonomia do personagem cognitivo (PRD §25).
--
-- Até aqui o Nilo só agia quando provocado: alguém falava, ele respondia e,
-- se o modelo mandasse, ia a um lugar ou seguia a pessoa. Sem ninguém, ele
-- passeava por um sorteio de chão. Com esta tabela ele passa a DECIDIR o que
-- fazer quando está livre — um objetivo em texto, uma HABILIDADE de uma
-- biblioteca fechada (código) e um prazo — e a manter a intenção por minutos
-- antes de deliberar de novo. Cada intenção fica aqui com o resultado, para
-- o painel ("o que ele resolveu fazer e deu em quê") e para o próprio
-- personagem: a próxima deliberação lê as anteriores, e a reflexão as leva
-- para o diário.
--
-- A habilidade é uma coluna com CHECK de padrão, não de lista: a lista mora no
-- código (packages/npc/src/skills.ts) e cresce lá; o banco só exige um nome
-- bem formado.
CREATE TABLE IF NOT EXISTS streampolis.npc_intentions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  npc_id      UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  -- O objetivo, nas palavras do modelo ("ver quem chega pelo portão sul").
  goal        TEXT NOT NULL CHECK (length(goal) <= 200),
  why         TEXT CHECK (length(why) <= 300),
  skill       TEXT NOT NULL CHECK (skill ~ '^[a-z_]{2,32}$'),
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 'deliberation' — o próprio personagem decidiu; 'conversation' — saiu de
  -- uma fala com alguém ("me leva até o telão"); 'default' — o passeio de
  -- quando não há plano.
  source      TEXT NOT NULL CHECK (source IN ('deliberation', 'conversation', 'default')),
  -- O motivo da deliberação que gerou esta intenção (prazo vencido, alguém
  -- chegou, começou a chover…).
  trigger     TEXT CHECK (length(trigger) <= 120),
  planned_min INTEGER NOT NULL DEFAULT 5,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  -- 'done' — cumpriu; 'expired' — o prazo venceu fazendo; 'failed' — não deu
  -- (lugar ocupado, preso); 'replaced' — trocou de plano antes; 'interrupted'
  -- — conversa/ordem de alguém tomou o lugar.
  outcome     TEXT CHECK (outcome IN ('done', 'expired', 'failed', 'replaced', 'interrupted')),
  -- Quantas trocas de conversa aconteceram enquanto durou: é a medida crua de
  -- "esta habilidade rende encontro", que a próxima deliberação lê.
  exchanges   INTEGER NOT NULL DEFAULT 0,
  room_id     TEXT
);

CREATE INDEX IF NOT EXISTS npc_intentions_recente ON streampolis.npc_intentions (npc_id, id DESC);
