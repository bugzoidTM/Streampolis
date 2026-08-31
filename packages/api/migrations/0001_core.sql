-- 0001_core.sql — schema próprio, identidade, avatar e progressão (SPECs §22, §24).
-- Tudo vive no schema `streampolis`: o schema `public` do Postgres hospedeiro
-- nunca é tocado.

CREATE SCHEMA IF NOT EXISTS streampolis;

CREATE TYPE streampolis.user_status AS ENUM (
  'active', 'suspended', 'banned', 'deleted'
);

CREATE TYPE streampolis.user_role AS ENUM (
  'player', 'moderator', 'admin'
);

CREATE TABLE streampolis.users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  email_lower     TEXT GENERATED ALWAYS AS (lower(email)) STORED,
  username        TEXT NOT NULL,
  username_lower  TEXT GENERATED ALWAYS AS (lower(username)) STORED,
  password_hash   TEXT,
  auth_provider   TEXT NOT NULL DEFAULT 'password',
  role            streampolis.user_role NOT NULL DEFAULT 'player',
  status          streampolis.user_status NOT NULL DEFAULT 'active',
  birth_date      DATE,
  age_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  economy_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  chat_muted_until TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- auth_provider 'password' sem hash seria uma conta sem senha: recusa no schema.
  CONSTRAINT users_password_present CHECK (
    auth_provider <> 'password' OR password_hash IS NOT NULL
  ),
  CONSTRAINT users_username_shape CHECK (username ~ '^[A-Za-z0-9_.]{3,24}$')
);

CREATE UNIQUE INDEX users_email_lower_key ON streampolis.users (email_lower);
CREATE UNIQUE INDEX users_username_lower_key ON streampolis.users (username_lower);

-- Refresh tokens ficam guardados por hash: um dump do banco não permite login.
CREATE TABLE streampolis.refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  family_id   UUID NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES streampolis.refresh_tokens(id),
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON streampolis.refresh_tokens (user_id, expires_at DESC);

CREATE TABLE streampolis.avatars (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL UNIQUE REFERENCES streampolis.users(id) ON DELETE CASCADE,
  body_preset TEXT NOT NULL DEFAULT 'preset_a',
  skin        TEXT NOT NULL DEFAULT 'skin_03',
  hair        TEXT,
  top         TEXT,
  bottom      TEXT,
  shoes       TEXT,
  accessory   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE streampolis.player_stats (
  user_id         UUID PRIMARY KEY REFERENCES streampolis.users(id) ON DELETE CASCADE,
  level           INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp              BIGINT  NOT NULL DEFAULT 0 CHECK (xp >= 0),
  fame            BIGINT  NOT NULL DEFAULT 0 CHECK (fame >= 0),
  gifter_xp       BIGINT  NOT NULL DEFAULT 0 CHECK (gifter_xp >= 0),
  gifter_level    INTEGER NOT NULL DEFAULT 1 CHECK (gifter_level >= 1),
  creator_points  BIGINT  NOT NULL DEFAULT 0 CHECK (creator_points >= 0),
  followers_count INTEGER NOT NULL DEFAULT 0 CHECK (followers_count >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE streampolis.profiles (
  user_id     UUID PRIMARY KEY REFERENCES streampolis.users(id) ON DELETE CASCADE,
  display_name TEXT,
  bio         TEXT CHECK (bio IS NULL OR length(bio) <= 400),
  country     TEXT,
  presence    TEXT NOT NULL DEFAULT 'offline'
              CHECK (presence IN ('offline','online','in_world','watching_live','streaming','in_pk')),
  presence_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
