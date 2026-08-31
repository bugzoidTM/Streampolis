-- 0002_economy.sql — Wallet Ledger (SPECs §24, §25, §27; PRD §14, §29).
-- O ledger é a fonte de verdade da economia (SPECs §68 regra 4).

CREATE TYPE streampolis.currency AS ENUM ('coins', 'credits');

CREATE TYPE streampolis.tx_type AS ENUM (
  'purchase',          -- Coins creditados por webhook validado
  'grant',             -- Credits concedidos por progressão/recompensa
  'spend',             -- compra de item / consumo
  'gift',              -- envio de presente (débito do remetente)
  'refund',            -- estorno de uma transação anterior
  'admin_adjustment'   -- ajuste manual auditado (§65)
);

CREATE TABLE streampolis.wallets (
  user_id         UUID PRIMARY KEY REFERENCES streampolis.users(id) ON DELETE CASCADE,
  credits_balance BIGINT NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
  coins_balance   BIGINT NOT NULL DEFAULT 0 CHECK (coins_balance >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Linha imutável (§29 do PRD). `amount` é assinado: débito negativo, crédito
-- positivo, e balance_after tem que bater exatamente — o CHECK impede um ledger
-- que "quase" fecha.
CREATE TABLE streampolis.wallet_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  currency        streampolis.currency NOT NULL,
  type            streampolis.tx_type NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount <> 0),
  balance_before  BIGINT NOT NULL CHECK (balance_before >= 0),
  balance_after   BIGINT NOT NULL CHECK (balance_after >= 0),
  reference_type  TEXT,
  reference_id    TEXT,
  idempotency_key TEXT NOT NULL,
  actor_id        UUID REFERENCES streampolis.users(id),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wallet_tx_balance_math CHECK (balance_after = balance_before + amount),
  CONSTRAINT wallet_tx_sign CHECK (
    (type = 'purchase'         AND amount > 0) OR
    (type = 'grant'            AND amount > 0) OR
    -- Estorno reverte o sinal do lançamento original: estornar uma compra
    -- DEBITA Coins, estornar um gift devolve. Por isso não fixa o sinal.
    (type = 'refund'           AND amount <> 0) OR
    (type = 'spend'            AND amount < 0) OR
    (type = 'gift'             AND amount < 0) OR
    (type = 'admin_adjustment')
  ),
  -- §65: ajuste administrativo sem admin e sem motivo é recusado pelo banco,
  -- não só pela aplicação.
  CONSTRAINT wallet_tx_admin_audited CHECK (
    type <> 'admin_adjustment'
    OR (actor_id IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason)) >= 3)
  )
);

-- §27: a mesma chave duas vezes produz UMA transação. Índice único global.
CREATE UNIQUE INDEX wallet_transactions_idempotency_key
  ON streampolis.wallet_transactions (idempotency_key);
CREATE INDEX wallet_transactions_user_idx
  ON streampolis.wallet_transactions (user_id, created_at DESC);
CREATE INDEX wallet_transactions_reference_idx
  ON streampolis.wallet_transactions (reference_type, reference_id);

-- Ledger é imutável: UPDATE/DELETE são recusados no próprio banco.
CREATE FUNCTION streampolis.reject_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_transactions é imutável (SPECs §24/§29): % recusado', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER wallet_transactions_immutable
  BEFORE UPDATE OR DELETE ON streampolis.wallet_transactions
  FOR EACH ROW EXECUTE FUNCTION streampolis.reject_ledger_mutation();

CREATE TABLE streampolis.coin_packages (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  coins        BIGINT NOT NULL CHECK (coins > 0),
  bonus_coins  BIGINT NOT NULL DEFAULT 0 CHECK (bonus_coins >= 0),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  currency     TEXT NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE streampolis.rarity AS ENUM
  ('common','rare','epic','legendary','mythic');

CREATE TABLE streampolis.gift_catalog (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'basic',
  coin_cost      BIGINT NOT NULL CHECK (coin_cost > 0),
  creator_points BIGINT NOT NULL CHECK (creator_points >= 0),
  pk_points      BIGINT NOT NULL CHECK (pk_points >= 0),
  animation_id   TEXT NOT NULL,
  rarity         streampolis.rarity NOT NULL DEFAULT 'common',
  catalog_version SMALLINT NOT NULL DEFAULT 1,
  active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE streampolis.gift_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id      UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  receiver_id    UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  live_id        UUID,
  gift_id        TEXT NOT NULL REFERENCES streampolis.gift_catalog(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  coin_total     BIGINT NOT NULL CHECK (coin_total > 0),
  creator_points BIGINT NOT NULL CHECK (creator_points >= 0),
  pk_points      BIGINT NOT NULL DEFAULT 0 CHECK (pk_points >= 0),
  transaction_id UUID NOT NULL UNIQUE REFERENCES streampolis.wallet_transactions(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT gift_no_self CHECK (sender_id <> receiver_id)
);
CREATE INDEX gift_events_live_idx ON streampolis.gift_events (live_id, created_at DESC);
CREATE INDEX gift_events_receiver_idx ON streampolis.gift_events (receiver_id, created_at DESC);
