-- =============================================================
-- ESTIMATES
-- Run this if you already applied schema.sql before estimates existed.
-- Safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- =============================================================

CREATE TABLE IF NOT EXISTS estimates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id            UUID REFERENCES projects(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  notes                 TEXT,
  currency              TEXT NOT NULL DEFAULT 'USD',
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  subtotal_amount       BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_amount >= 0),
  total_amount          BIGINT NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  sent_at               TIMESTAMPTZ,
  responded_at          TIMESTAMPTZ,
  created_by            UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estimates_account_id ON estimates(account_id);
CREATE INDEX IF NOT EXISTS idx_estimates_project_id ON estimates(project_id);
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimates_created_at ON estimates(created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_estimates_updated_at
    BEFORE UPDATE ON estimates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estimates_service_role_all" ON estimates;
CREATE POLICY "estimates_service_role_all" ON estimates
  USING (TRUE) WITH CHECK (TRUE);

CREATE TABLE IF NOT EXISTS estimate_line_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id     UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        INT NOT NULL CHECK (quantity > 0),
  unit_amount     BIGINT NOT NULL CHECK (unit_amount >= 0),
  total_amount    BIGINT NOT NULL CHECK (total_amount >= 0),
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estimate_line_items_estimate_id ON estimate_line_items(estimate_id);

DO $$ BEGIN
  CREATE TRIGGER trg_estimate_line_items_updated_at
    BEFORE UPDATE ON estimate_line_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estimate_line_items_service_role_all" ON estimate_line_items;
CREATE POLICY "estimate_line_items_service_role_all" ON estimate_line_items
  USING (TRUE) WITH CHECK (TRUE);

CREATE TABLE IF NOT EXISTS estimate_idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  estimate_id     UUID REFERENCES estimates(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed')),
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_estimate_idempotency_keys_lookup
  ON estimate_idempotency_keys(account_id, user_id, idempotency_key);

ALTER TABLE estimate_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estimate_idempotency_keys_service_role_all" ON estimate_idempotency_keys;
CREATE POLICY "estimate_idempotency_keys_service_role_all" ON estimate_idempotency_keys
  USING (TRUE) WITH CHECK (TRUE);
