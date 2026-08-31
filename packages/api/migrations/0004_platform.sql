-- 0004_platform.sql — pagamentos (§28/§29), feature flags (§64), audit log (§37/§65).

CREATE TYPE streampolis.payment_status AS ENUM
  ('pending','paid','failed','canceled','refunded');

CREATE TABLE streampolis.payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES streampolis.users(id) ON DELETE RESTRICT,
  provider            TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  package_id          TEXT NOT NULL REFERENCES streampolis.coin_packages(id),
  coins               BIGINT NOT NULL CHECK (coins > 0),
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  currency            TEXT NOT NULL DEFAULT 'BRL',
  status              streampolis.payment_status NOT NULL DEFAULT 'pending',
  checkout_url        TEXT,
  credit_tx_id        UUID REFERENCES streampolis.wallet_transactions(id),
  refund_tx_id        UUID REFERENCES streampolis.wallet_transactions(id),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ,
  UNIQUE (provider, provider_payment_id),
  -- Pago sem transação de crédito seria Coins prometidos e não entregues.
  CONSTRAINT payment_paid_has_credit CHECK (status <> 'paid' OR credit_tx_id IS NOT NULL)
);
CREATE INDEX payments_user_idx ON streampolis.payments (user_id, created_at DESC);

-- §62: dedupe já na porta de entrada. A mesma entrega do gateway grava uma vez.
CREATE TABLE streampolis.webhook_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  signature    TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  result       TEXT,
  UNIQUE (provider, event_id)
);

CREATE TABLE streampolis.feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  updated_by  UUID REFERENCES streampolis.users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE streampolis.audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    UUID REFERENCES streampolis.users(id),
  actor_role  streampolis.user_role,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  reason      TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor_idx ON streampolis.audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_action_idx ON streampolis.audit_log (action, created_at DESC);

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON streampolis.audit_log
  FOR EACH ROW EXECUTE FUNCTION streampolis.reject_ledger_mutation();
