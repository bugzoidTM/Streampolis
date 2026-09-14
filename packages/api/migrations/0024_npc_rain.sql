-- 0024_npc_rain.sql — abrigo da chuva (clima do mundo, shared/weather.ts).
--
-- GERADO por packages/npc/scripts/gen-population.mjs (bloco CHUVA); não edite
-- à mão. Acrescenta `rain` {sceneId, program} ao profile de cinco figurantes
-- da praça: quando a sala publica chuva, eles trocam para um interior
-- disponível; os outros se abrigam nos pontos cobertos da própria praça
-- (copas, toldos, marquises — regra em packages/npc/src/scenes.ts).
UPDATE streampolis.npc_agents SET profile = profile || '{"rain":{"sceneId":"residential_lobby","role":"abrigado da chuva no saguão","program":[{"do":"walk","to":{"x":0,"z":5.5},"secs":[20,50]},{"do":"walk","to":{"x":-6,"z":-4},"secs":[15,40]},{"do":"walk","to":{"x":6,"z":-4},"secs":[15,40]}]}}'::jsonb WHERE slug = 'edu';
UPDATE streampolis.npc_agents SET profile = profile || '{"rain":{"sceneId":"stream_store","role":"abrigada da chuva na loja","program":[{"do":"walk","to":{"x":-1.6,"z":-3},"secs":[15,40]},{"do":"walk","to":{"x":1.6,"z":0.3},"secs":[15,40]},{"do":"walk","to":{"x":0,"z":4.6},"secs":[20,50]}]}}'::jsonb WHERE slug = 'cintia';
UPDATE streampolis.npc_agents SET profile = profile || '{"rain":{"sceneId":"stream_store","role":"abrigado da chuva na loja","program":[{"do":"walk","to":{"x":-1.6,"z":-3},"secs":[15,40]},{"do":"walk","to":{"x":1.6,"z":0.3},"secs":[15,40]},{"do":"walk","to":{"x":0,"z":4.6},"secs":[20,50]}]}}'::jsonb WHERE slug = 'wagner';
UPDATE streampolis.npc_agents SET profile = profile || '{"rain":{"sceneId":"residential_lobby","role":"abrigada da chuva no saguão","program":[{"do":"walk","to":{"x":0,"z":5.5},"secs":[20,50]},{"do":"walk","to":{"x":-6,"z":-4},"secs":[15,40]},{"do":"walk","to":{"x":6,"z":-4},"secs":[15,40]}]}}'::jsonb WHERE slug = 'larissa';
UPDATE streampolis.npc_agents SET profile = profile || '{"rain":{"sceneId":"residential_lobby","role":"abrigada da chuva no saguão","program":[{"do":"walk","to":{"x":0,"z":5.5},"secs":[20,50]},{"do":"walk","to":{"x":-6,"z":-4},"secs":[15,40]},{"do":"walk","to":{"x":6,"z":-4},"secs":[15,40]}]}}'::jsonb WHERE slug = 'joana';
