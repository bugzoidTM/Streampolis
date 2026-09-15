-- 0027_npc_intention_world.sql — o mundo no instante em que a intenção começou.
--
-- A fadiga de intenção (packages/npc/src/fatigue.ts) penaliza o cognitivo por
-- repetir a mesma habilidade com o mesmo alvo — ou um objetivo equivalente —
-- numa janela recente, SALVO quando algo de fato mudou no mundo desde a última
-- vez. Para saber se mudou, cada intenção guarda um retrato mínimo do mundo ao
-- começar: clima, se era noite e quem (de verdade) estava na cena. A próxima
-- deliberação compara o retrato de então com o de agora.
ALTER TABLE streampolis.npc_intentions ADD COLUMN IF NOT EXISTS world JSONB;
