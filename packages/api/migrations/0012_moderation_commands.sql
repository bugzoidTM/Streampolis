-- 0012_moderation_commands.sql — o painel mandando no mundo (PRD §28).
--
-- Até aqui a conversa entre API e game server tinha um sentido só: o game
-- server contava o que acontecia. Encerrar uma live pelo painel exige o sentido
-- contrário, e a forma mais barata de conseguir isso sem abrir porta nova no
-- game server é uma FILA que ele já vai buscar sozinho — o batimento de
-- presença, que acontece a cada poucos segundos, volta com o que houver aqui.
--
-- Uma linha por ordem, com quem mandou e por quê. Não é um canal genérico de
-- RPC de propósito: `command` é uma lista fechada, porque uma fila que executa
-- qualquer coisa vinda do banco é uma execução remota esperando um SQL injection
-- em outro lugar do sistema.
CREATE TABLE streampolis.moderation_commands (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  command      TEXT NOT NULL CHECK (command IN ('close_live')),
  target_type  TEXT NOT NULL CHECK (target_type IN ('room')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  issued_by    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Entregue = algum worker levou a ordem. Executado = a sala confirmou.
  delivered_at TIMESTAMPTZ,
  delivered_to TEXT,
  acked_at     TIMESTAMPTZ,
  ack_result   TEXT
);

-- A busca do batimento: só o que ainda não foi entregue, mais recente primeiro.
CREATE INDEX moderation_commands_pending_idx
  ON streampolis.moderation_commands (target_id, issued_at)
  WHERE delivered_at IS NULL;
