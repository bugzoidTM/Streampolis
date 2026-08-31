-- 0003_world_social.sql — lives, PK, social, inventário, casa, agências (§24).

CREATE TABLE streampolis.stream_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id           UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  category          TEXT NOT NULL DEFAULT 'geral',
  room_id           TEXT,
  status            TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','ended')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  peak_real_viewers INTEGER NOT NULL DEFAULT 0 CHECK (peak_real_viewers >= 0),
  unique_viewers    INTEGER NOT NULL DEFAULT 0 CHECK (unique_viewers >= 0),
  likes             BIGINT NOT NULL DEFAULT 0 CHECK (likes >= 0),
  gift_coin_total   BIGINT NOT NULL DEFAULT 0 CHECK (gift_coin_total >= 0)
);
-- Um host tem no máximo uma live no ar.
CREATE UNIQUE INDEX stream_sessions_one_live_per_host
  ON streampolis.stream_sessions (host_id) WHERE status = 'live';
CREATE INDEX stream_sessions_live_idx
  ON streampolis.stream_sessions (status, started_at DESC);

CREATE TABLE streampolis.stream_viewers (
  stream_id UUID NOT NULL REFERENCES streampolis.stream_sessions(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at   TIMESTAMPTZ,
  muted     BOOLEAN NOT NULL DEFAULT FALSE,
  kicked    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (stream_id, user_id)
);

CREATE TYPE streampolis.pk_status AS ENUM
  ('WAITING','COUNTDOWN','ACTIVE','OVERTIME','FINISHED');

CREATE TABLE streampolis.pk_matches (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_a      UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  host_b      UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  stream_id   UUID REFERENCES streampolis.stream_sessions(id) ON DELETE SET NULL,
  status      streampolis.pk_status NOT NULL DEFAULT 'WAITING',
  score_a     BIGINT NOT NULL DEFAULT 0 CHECK (score_a >= 0),
  score_b     BIGINT NOT NULL DEFAULT 0 CHECK (score_b >= 0),
  -- Contador de ordem total dos gifts aplicados: cada aplicação incrementa sob
  -- lock da linha, então dois gifts "simultâneos" ganham ordem determinada (§63).
  event_seq   BIGINT NOT NULL DEFAULT 0 CHECK (event_seq >= 0),
  started_at  TIMESTAMPTZ,
  ends_at     TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  winner_id   UUID REFERENCES streampolis.users(id),
  result_kind TEXT CHECK (result_kind IN ('a','b','draw')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_distinct_hosts CHECK (host_a <> host_b),
  CONSTRAINT pk_finished_has_result CHECK (
    status <> 'FINISHED' OR (result_kind IS NOT NULL AND ended_at IS NOT NULL)
  )
);

-- Log de aplicação de pontos: prova de ordenação consistente no último tick.
CREATE TABLE streampolis.pk_gift_applications (
  match_id      UUID NOT NULL REFERENCES streampolis.pk_matches(id) ON DELETE CASCADE,
  seq           BIGINT NOT NULL,
  gift_event_id UUID NOT NULL REFERENCES streampolis.gift_events(id) ON DELETE CASCADE,
  team          CHAR(1) NOT NULL CHECK (team IN ('a','b')),
  points        BIGINT NOT NULL CHECK (points >= 0),
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, seq),
  UNIQUE (gift_event_id)
);

CREATE TABLE streampolis.follows (
  follower_id UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  followed_id UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT follow_no_self CHECK (follower_id <> followed_id)
);
CREATE INDEX follows_followed_idx ON streampolis.follows (followed_id, created_at DESC);

CREATE TYPE streampolis.friendship_status AS ENUM ('pending','accepted','blocked');

-- user_a < user_b sempre: uma amizade tem exatamente uma linha.
CREATE TABLE streampolis.friendships (
  user_a       UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  user_b       UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  status       streampolis.friendship_status NOT NULL DEFAULT 'pending',
  requested_by UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CONSTRAINT friendship_ordered CHECK (user_a < user_b)
);

CREATE TABLE streampolis.items (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  name          TEXT NOT NULL,
  rarity        streampolis.rarity NOT NULL DEFAULT 'common',
  credits_price BIGINT CHECK (credits_price IS NULL OR credits_price >= 0),
  coins_price   BIGINT CHECK (coins_price IS NULL OR coins_price >= 0),
  asset_id      TEXT NOT NULL,
  footprint_x   SMALLINT,
  footprint_y   SMALLINT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE streampolis.inventory (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL REFERENCES streampolis.items(id),
  quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_id)
);

CREATE TABLE streampolis.properties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  property_type TEXT NOT NULL DEFAULT 'apartment',
  layout_id     TEXT NOT NULL DEFAULT 'studio_01',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX properties_owner_idx ON streampolis.properties (owner_id);

CREATE TABLE streampolis.property_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id      UUID NOT NULL REFERENCES streampolis.properties(id) ON DELETE CASCADE,
  item_instance_id UUID NOT NULL REFERENCES streampolis.inventory(id) ON DELETE CASCADE,
  position         JSONB NOT NULL,
  rotation         REAL NOT NULL DEFAULT 0,
  placed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_instance_id)
);

CREATE TABLE streampolis.agencies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  name       TEXT NOT NULL,
  name_lower TEXT GENERATED ALWAYS AS (lower(name)) STORED,
  level      INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  fame       BIGINT NOT NULL DEFAULT 0 CHECK (fame >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agencies_name_key ON streampolis.agencies (name_lower);

CREATE TYPE streampolis.agency_role AS ENUM ('owner','manager','member');

CREATE TABLE streampolis.agency_members (
  agency_id UUID NOT NULL REFERENCES streampolis.agencies(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  role      streampolis.agency_role NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, user_id)
);
-- Um usuário pertence a no máximo uma agência.
CREATE UNIQUE INDEX agency_members_one_agency ON streampolis.agency_members (user_id);

CREATE TABLE streampolis.moderation_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  target_id   UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('chat','profile','live','avatar','other')),
  reason      TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  context_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','reviewing','resolved','rejected')),
  resolved_by UUID REFERENCES streampolis.users(id),
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT report_no_self CHECK (reporter_id <> target_id)
);
CREATE INDEX moderation_reports_status_idx
  ON streampolis.moderation_reports (status, created_at DESC);

CREATE TABLE streampolis.user_blocks (
  user_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_id),
  CONSTRAINT block_no_self CHECK (user_id <> blocked_id)
);
