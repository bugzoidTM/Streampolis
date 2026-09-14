-- 0023_npc_schedule.sql — rotina por horário (relógio do mundo, shared/clock.ts).
--
-- GERADO por packages/npc/scripts/gen-population.mjs (bloco AGENDA); não
-- edite à mão. Acrescenta ao `profile` dos personagens de ambiente:
--   hours  [de, até) em horas do mundo — fora da janela o corpo sai da sala;
--   night  {sceneId, program, hours} — turno noturno noutra cena.
-- Quem não aparece aqui está na cidade o dia inteiro. Nenhum mapa, bico ou
-- regra de jogo muda: só quem está onde, a que horas.
UPDATE streampolis.npc_agents SET profile = profile || '{"night":{"sceneId":"noir_district","hours":[19,6],"role":"caminhando pela avenida (noite)","program":[{"do":"walk","to":{"x":-50,"z":4.2},"secs":[1,4]},{"do":"walk","to":{"x":-32,"z":5},"secs":[3,8]},{"do":"walk","to":{"x":-14,"z":3.4},"secs":[1,4]},{"do":"walk","to":{"x":4,"z":4.6},"secs":[1,4]},{"do":"walk","to":{"x":-14,"z":3.4},"secs":[1,4]},{"do":"walk","to":{"x":-32,"z":5},"secs":[1,4]},{"do":"walk","to":{"x":-50,"z":4.2},"secs":[1,4]}]}}'::jsonb WHERE slug = 'marcos';
UPDATE streampolis.npc_agents SET profile = profile || '{"night":{"sceneId":"noir_district","hours":[19,6],"role":"caminhando pela avenida (noite)","program":[{"do":"walk","to":{"x":-2,"z":-5.4},"secs":[1,4]},{"do":"walk","to":{"x":16,"z":-4},"secs":[1,4]},{"do":"walk","to":{"x":34,"z":-5.2},"secs":[2.4,7.4]},{"do":"walk","to":{"x":52,"z":-4.4},"secs":[1,4]},{"do":"walk","to":{"x":34,"z":-5.2},"secs":[1,4]},{"do":"walk","to":{"x":16,"z":-4},"secs":[1,4]},{"do":"walk","to":{"x":-2,"z":-5.4},"secs":[1,4]}]}}'::jsonb WHERE slug = 'renata';
UPDATE streampolis.npc_agents SET profile = profile || '{"night":{"sceneId":"noir_district","hours":[19,6],"role":"caminhando pela travessa (noite)","program":[{"do":"walk","to":{"x":-34,"z":-36.3},"secs":[1,4]},{"do":"walk","to":{"x":-10,"z":-37.1},"secs":[4,9]},{"do":"walk","to":{"x":18,"z":-35.9},"secs":[1,4]},{"do":"walk","to":{"x":-10,"z":-37.1},"secs":[1,4]},{"do":"walk","to":{"x":-34,"z":-36.3},"secs":[1,4]}]}}'::jsonb WHERE slug = 'tiago';
UPDATE streampolis.npc_agents SET profile = profile || '{"night":{"sceneId":"noir_district","hours":[19,6],"role":"caminhando pela avenida (noite)","program":[{"do":"walk","to":{"x":40,"z":4.4},"secs":[1,4]},{"do":"walk","to":{"x":16,"z":5.2},"secs":[3,8]},{"do":"walk","to":{"x":-8,"z":3.8},"secs":[1,4]},{"do":"walk","to":{"x":-30,"z":5},"secs":[2,7]},{"do":"walk","to":{"x":-8,"z":3.8},"secs":[1,4]},{"do":"walk","to":{"x":16,"z":5.2},"secs":[1,4]},{"do":"walk","to":{"x":40,"z":4.4},"secs":[1,4]}]}}'::jsonb WHERE slug = 'paula';
UPDATE streampolis.npc_agents SET profile = profile || '{"night":{"sceneId":"noir_district","hours":[19,6],"role":"na esquina do bar (noite)","program":[{"do":"stand","at":{"x":-48.6,"z":-5.2},"yaw":2.542,"secs":[120,300]},{"do":"walk","to":{"x":-44,"z":4},"secs":[10,25]}]}}'::jsonb WHERE slug = 'ivo';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[6,23]}'::jsonb WHERE slug = 'edu';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[6,23]}'::jsonb WHERE slug = 'cintia';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[7,21]}'::jsonb WHERE slug = 'seu-antenor';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[7,20]}'::jsonb WHERE slug = 'dona-lurdes';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,20]}'::jsonb WHERE slug = 'henrique';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,20]}'::jsonb WHERE slug = 'simone';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[7,23]}'::jsonb WHERE slug = 'seu-nelson';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[6,22]}'::jsonb WHERE slug = 'joana';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[18,6]}'::jsonb WHERE slug = 'nando';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[18,6]}'::jsonb WHERE slug = 'cida';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[19,5]}'::jsonb WHERE slug = 'lipe';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[19,5]}'::jsonb WHERE slug = 'duda';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[18,6]}'::jsonb WHERE slug = 'genivaldo';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[17,7]}'::jsonb WHERE slug = 'rosa';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[20,6]}'::jsonb WHERE slug = 'vitor';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[6,18]}'::jsonb WHERE slug = 'toninho';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,22]}'::jsonb WHERE slug = 'ronaldo';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,22]}'::jsonb WHERE slug = 'kesia';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,22]}'::jsonb WHERE slug = 'miguel';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[9,21]}'::jsonb WHERE slug = 'tania';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,19]}'::jsonb WHERE slug = 'anderson';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,19]}'::jsonb WHERE slug = 'sofia';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,19]}'::jsonb WHERE slug = 'leandro';
UPDATE streampolis.npc_agents SET profile = profile || '{"hours":[8,19]}'::jsonb WHERE slug = 'claudio';
