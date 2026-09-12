-- 0021_npc.sql — o primeiro personagem da cidade (PRD §25).
--
-- Até aqui "NPC" no Streampolis era figuração: `AmbientCrowd.ts` desenha gente
-- andando na praça, sem nome, sem colisão, e o servidor nunca ouviu falar
-- deles. O que entra com esta migration é outra coisa: UM personagem que é um
-- cliente da sala como outro qualquer — anda, fala, é visto por todos —, mas
-- cuja cabeça mora num processo próprio (`packages/npc`), guiado por um LLM,
-- com memória e persona que mudam com a história do jogo.
--
-- ## O que aqui é regra, e não dado
--
-- Duas decisões desta tabela são o que torna o personagem SUPERVISIONÁVEL:
--
--   1. O modelo não muda — o que muda é o que ele carrega. Não há peso, não há
--      fine-tuning: "aprender" é acumular texto (memória, diário, persona)
--      versionado, legível e revertível por um administrador.
--   2. A persona é VERSIONADA e o personagem só propõe a próxima versão. Ela
--      entra no ar se um auditor (segundo chamado de LLM, prompt diferente) e
--      os invariantes de código (nome, condição de NPC) aprovarem; senão fica
--      `pending` até um humano ativar. Reverter é ativar uma versão anterior.
--
-- A identidade é um UUID de propósito. O game server marca atividade social
-- em lote com `unnest($1::uuid[])`: um id fora do formato derrubaria o LOTE
-- inteiro — e com ele a métrica dos jogadores de verdade que falaram no mesmo
-- batimento. O UUID não está em `users`, então o JOIN o descarta sem erro.
CREATE TABLE streampolis.npc_agents (
  id            UUID PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,32}$'),
  -- O nome é INVARIANTE da persona: aparece na placa, no chat e no token, e é
  -- pelo nome que um jogador o chama. Mora aqui, fora do JSON que o modelo
  -- reescreve, para que nenhuma versão de persona possa trocá-lo.
  display_name  TEXT NOT NULL CHECK (length(btrim(display_name)) BETWEEN 2 AND 24),
  -- Aparência assinada no token, no mesmo formato que `avatars.config`.
  avatar        JSONB NOT NULL,
  -- Onde ele mora. Uma cena por personagem nesta fase.
  scene_id      TEXT NOT NULL DEFAULT 'central_plaza',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  -- O processo do personagem bate aqui a cada meio minuto. "Está online" é
  -- `last_heartbeat` recente — nunca um booleano que alguém esqueceu de apagar.
  last_heartbeat TIMESTAMPTZ,
  room_id       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada linha é UMA versão inteira da persona, nunca um diff: reverter é
-- apontar para outra linha, e comparar duas é ler as duas.
CREATE TABLE streampolis.npc_persona_versions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  npc_id      UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  persona     JSONB NOT NULL,
  -- 'seed' — a versão inicial, escrita à mão; 'reflection' — proposta pelo
  -- próprio personagem depois de refletir; 'admin' — editada no painel.
  source      TEXT NOT NULL CHECK (source IN ('seed', 'reflection', 'admin')),
  -- 'active' — a que está no ar (uma só por personagem); 'pending' — proposta
  -- que o auditor não aprovou sozinho e espera um humano; 'retired' — já foi
  -- ativa; 'rejected' — recusada no painel.
  status      TEXT NOT NULL CHECK (status IN ('active', 'pending', 'retired', 'rejected')),
  -- O veredito do auditor e o dos invariantes, guardados junto: o painel
  -- precisa mostrar POR QUE uma versão ficou pendente.
  audit       JSONB,
  -- Em que diário esta versão se baseou — a trilha de "mudou por causa de quê".
  based_on_diary BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  activated_by UUID REFERENCES streampolis.users(id),
  UNIQUE (npc_id, version)
);

CREATE UNIQUE INDEX npc_persona_uma_ativa
  ON streampolis.npc_persona_versions (npc_id) WHERE status = 'active';

-- Memória episódica: o que aconteceu, com quem, onde. É o que a persona e o
-- diário são feitos de, e é o que o painel mostra quando alguém pergunta "por
-- que ele disse isso?".
CREATE TABLE streampolis.npc_memory (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  npc_id      UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  -- 'heard' — alguém falou na sala; 'said' — ele falou; 'met' — alguém
  -- chegou perto; 'event' — algo da cidade (evento, hora, sala cheia).
  kind        TEXT NOT NULL CHECK (kind IN ('heard', 'said', 'met', 'event')),
  -- Quem (não é FK: um jogador pode apagar a conta e a lembrança fica, sem
  -- nome — o nome é copiado abaixo no momento).
  user_id     UUID,
  user_name   TEXT,
  text        TEXT NOT NULL CHECK (length(text) <= 400),
  room_id     TEXT,
  -- Já entrou em algum diário? A reflexão só lê o que ainda não leu.
  reflected   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX npc_memory_recente ON streampolis.npc_memory (npc_id, created_at DESC);
CREATE INDEX npc_memory_por_pessoa ON streampolis.npc_memory (npc_id, user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX npc_memory_nao_refletida ON streampolis.npc_memory (npc_id, id)
  WHERE reflected = FALSE;

-- Quem ele conhece. Uma linha por pessoa, com o que ele anotou dela. É a
-- memória de longo prazo que faz o "oi de novo, Ana" ser possível.
CREATE TABLE streampolis.npc_people (
  npc_id      UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  user_name   TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  encounters  INTEGER NOT NULL DEFAULT 1,
  exchanges   INTEGER NOT NULL DEFAULT 0,
  -- Observações curtas, as mais recentes por último. Teto no código (8).
  notes       TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (npc_id, user_id)
);

-- O diário: a reflexão em primeira pessoa sobre o que viveu desde a última.
-- É daqui que a próxima versão da persona é proposta.
CREATE TABLE streampolis.npc_diary (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  npc_id      UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  entry       TEXT NOT NULL CHECK (length(entry) <= 1200),
  memories    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX npc_diary_recente ON streampolis.npc_diary (npc_id, created_at DESC);

-- Cada chamada ao LLM, com latência e resultado. "Mensurável" começa por saber
-- quanto ele custa por dia e quantas vezes o modelo devolveu lixo.
CREATE TABLE streampolis.npc_calls (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  npc_id      UUID NOT NULL REFERENCES streampolis.npc_agents(id) ON DELETE CASCADE,
  -- 'chat' — conversa (modelo barato); 'deep' — diário, persona, auditoria.
  tier        TEXT NOT NULL CHECK (tier IN ('chat', 'deep')),
  purpose     TEXT NOT NULL CHECK (purpose ~ '^[a-z_]{2,32}$'),
  model       TEXT NOT NULL,
  ok          BOOLEAN NOT NULL,
  error       TEXT,
  latency_ms  INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  reply_chars INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX npc_calls_recente ON streampolis.npc_calls (npc_id, created_at DESC);

-- O freio de mão (SPECs §64). Desligada, o processo do personagem sai da sala
-- e fica quieto — sem redeploy. Lida pelo worker direto do banco.
INSERT INTO streampolis.feature_flags (key, enabled, description) VALUES
  ('npc_enabled', TRUE, 'Personagens da cidade (PRD §25): presença e fala do NPC guiado por LLM.')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- ## Nilo
--
-- O primeiro. Roupa de aventureiro porque a história dele é de quem chegou à
-- praça antes de todo mundo. A persona abaixo é a SEMENTE: três traços, uma
-- voz e um passado curto. O resto ele escreve — no diário, a partir do que
-- viver com quem passar por ali.
INSERT INTO streampolis.npc_agents (id, slug, display_name, avatar, scene_id)
VALUES (
  '5e1f0000-0000-4000-8000-000000000001',
  'nilo',
  'Nilo',
  '{"bodyPreset":0,"skinTone":4,"facePreset":0,"hair":"m_adventurer_head","hairColor":2,"top":"m_adventurer_top","bottom":"m_adventurer_bottom","shoes":"m_adventurer_shoes","accessory":"","height":1.02,"body":"v1"}'::jsonb,
  'central_plaza'
);

INSERT INTO streampolis.npc_persona_versions (npc_id, version, persona, source, status, activated_at)
VALUES (
  '5e1f0000-0000-4000-8000-000000000001',
  1,
  '{
    "name": "Nilo",
    "kind": "npc",
    "essence": "Personagem da praça de Streampolis. Chegou antes de a cidade ter nome e ficou; conhece cada banco e cada poste, e gosta mais de ouvir histórias do que de contar as suas.",
    "traits": ["curioso", "observador", "bem-humorado sem forçar", "leal a quem volta"],
    "voice": "Fala pouco e direto, em português do Brasil, como quem conversa num banco de praça. Nunca faz discurso. Pergunta mais do que afirma. Chama as pessoas pelo nome quando sabe.",
    "likes": ["fim de tarde no telão", "quem aparece de novo", "ouvir de onde as pessoas vêm"],
    "dislikes": ["praça vazia", "gente com pressa", "promessa fácil"],
    "history": ["Chegou à praça quando ela era só um monumento e um telão apagado."],
    "opinions": [],
    "relationships": []
  }'::jsonb,
  'seed',
  'active',
  now()
);
