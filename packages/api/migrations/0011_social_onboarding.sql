-- 0011_social_onboarding.sql — amizade, moderação e o primeiro dia de uma conta.
--
-- Nenhuma tabela nova de social: `friendships`, `user_blocks` e
-- `moderation_reports` existem desde 0003 e nunca tiveram rota. O que falta é
-- índice para as perguntas que as telas fazem e uma tabela para o onboarding,
-- que é a única coisa aqui que o schema ainda não sabia guardar.

-- A amizade é UMA linha com o par ordenado (user_a < user_b), o que torna a
-- chave primária um índice só de `user_a`. Só que a pergunta da tela é "quem são
-- os meus amigos", e metade deles me tem como `user_b` — sem este índice, quem
-- tiver um uuid alto varre a tabela inteira a cada abertura do painel.
CREATE INDEX friendships_user_b_idx ON streampolis.friendships (user_b);

-- Convites esperando resposta. Parcial de propósito: 'pending' é a minoria das
-- linhas e é a única fatia consultada com frequência (o sino de convites).
CREATE INDEX friendships_pending_idx
  ON streampolis.friendships (requested_by) WHERE status = 'pending';

-- Denúncia repetida do mesmo alvo pelo mesmo motivo é ruído para quem for
-- moderar. O índice é o que deixa a checagem "já denunciei isto hoje?" barata.
CREATE INDEX moderation_reports_pair_idx
  ON streampolis.moderation_reports (reporter_id, target_id, created_at DESC);

-- Bloqueio é uma relação DIRECIONAL e a leitura quente é a inversa da chave:
-- "quem me bloqueou" decide se um pedido de amizade pode sair.
CREATE INDEX user_blocks_blocked_idx ON streampolis.user_blocks (blocked_id);

/*
 * Onboarding (PRD §24).
 *
 * Uma linha por passo CUMPRIDO — a ausência é o estado inicial, e não existe
 * "passo pendente" guardado. Isso é o que permite acrescentar um sexto passo
 * amanhã sem migrar a conta de ninguém: quem não tem a linha simplesmente ainda
 * não fez.
 *
 * O passo é escrito pelo servidor quando ele OBSERVA o ato (o retrato de
 * presença do game server, o PUT do avatar), nunca por um cliente dizendo "já
 * fiz". Um onboarding que o navegador marca sozinho é uma lista de tarefas que
 * se completa com o console aberto.
 */
CREATE TABLE streampolis.onboarding_steps (
  user_id UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  step    TEXT NOT NULL CHECK (step IN (
            'create_avatar', 'enter_plaza', 'watch_live', 'visit_apartment', 'open_live'
          )),
  done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, step)
);
