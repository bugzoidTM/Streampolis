-- 0018_temporary_ban.sql — banimento temporário (PRD §27).
--
-- O §27 lista "banimento temporário" e "banimento permanente" como recursos
-- OBRIGATÓRIOS, e só o segundo existia: suspender era um estado sem prazo, que
-- alguém tinha de lembrar de desfazer à mão. Na prática isso vira uma de duas
-- coisas ruins — ou a suspensão de três dias dura três meses porque ninguém
-- voltou nela, ou a moderação evita suspender e usa advertência para tudo.
--
-- A data é o prazo. Quem tem `suspended_until` no futuro está suspenso; quando
-- a data passa, a própria leitura de identidade devolve a conta ao ar, sem
-- ninguém precisar agir.
ALTER TABLE streampolis.users
  ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
