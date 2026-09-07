-- 0016_fame.sql — fama derivada (PRD §22).
--
-- `player_stats.fame` existia desde a 0001 e só crescia num lugar: vitória de
-- PK. As outras seis fontes que o §22 lista — espectadores, seguidores, lives,
-- missões, Creator Points e consistência — nunca chegaram nela.
--
-- A coluna continua existindo porque o ranking precisa ORDENAR por fama, e
-- ordenar por uma conta que roda em sete tabelas a cada leitura de ranking não
-- se sustenta. O que muda é a origem: ela deixa de ser um contador que alguém
-- incrementa e passa a ser o resultado de uma conta, recalculado quando está
-- velho.
--
-- `fame_updated_at` é o que torna isso possível sem agendador: quem lê um
-- perfil velho paga o recálculo daquela pessoa, e só dela.
ALTER TABLE streampolis.player_stats
  ADD COLUMN IF NOT EXISTS fame_updated_at TIMESTAMPTZ;
