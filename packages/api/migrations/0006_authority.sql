-- 0006_authority.sql — quem é dono de qual verdade.
--
-- Duas correções de autoridade, não de forma:
--
-- 1. O placar de PK é do game server (SPECs §33). Para a API guardar o
--    resultado que ele apurou sem duplicar fama num retry, a batalha precisa do
--    id EXTERNO que o servidor gerou, com unicidade no banco.
--
-- 2. A aparência do jogador é dado persistido, não algo que o navegador informa
--    ao entrar numa sala. As colunas soltas de `avatars` não conseguem
--    representar o AvatarConfig que cliente e servidor trocam (presets
--    numéricos, altura, cor de cabelo), então o config canônico passa a viver
--    como JSONB validado pela API, e é ELE que entra assinado no token.

ALTER TABLE streampolis.pk_matches
  ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX pk_matches_external_id_key
  ON streampolis.pk_matches (external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE streampolis.avatars
  ADD COLUMN config JSONB NOT NULL DEFAULT jsonb_build_object(
    'bodyPreset', 0,
    'skinTone', 3,
    'facePreset', 0,
    'hair', 'hair_bob_01',
    'hairColor', 1,
    'top', 'top_tee_01',
    'bottom', 'bottom_jeans_01',
    'shoes', 'shoes_sneaker_01',
    'accessory', '',
    'height', 1.0
  );

-- Um config sem as chaves obrigatórias entraria como `undefined` no cliente e
-- viraria um avatar sem corpo; o banco recusa antes disso.
ALTER TABLE streampolis.avatars
  ADD CONSTRAINT avatars_config_shape CHECK (
    config ? 'bodyPreset' AND config ? 'skinTone' AND config ? 'facePreset'
    AND config ? 'hair' AND config ? 'hairColor' AND config ? 'top'
    AND config ? 'bottom' AND config ? 'shoes' AND config ? 'accessory'
    AND config ? 'height'
  );

-- Sessões de live: o game server precisa registrar a live que ABRIU para poder
-- ligar gifts e PK a ela, e o dono da sessão é sempre o host autenticado.
ALTER TABLE streampolis.stream_sessions
  ADD COLUMN external_id TEXT;

CREATE UNIQUE INDEX stream_sessions_external_id_key
  ON streampolis.stream_sessions (external_id)
  WHERE external_id IS NOT NULL;

-- Privacidade do apartamento é do banco, não do navegador: hoje o cliente
-- manda `visibility` no join, o que deixaria qualquer um abrir a casa alheia.
ALTER TABLE streampolis.properties
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'open'
    CHECK (visibility IN ('open', 'friends', 'private'));
