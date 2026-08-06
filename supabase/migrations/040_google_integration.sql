-- ============================================================
-- 040_google_integration
--
-- Google OAuth connection per account — authorizes both Calendar
-- (appointment booking, Phase 4b) and Sheets (lead sync, Phase 5)
-- scopes from one consent screen, so one row covers both. If a
-- client ever needs Sheets and Calendar on different Google
-- identities, split this into two tables then; not needed for v1.
--
-- Tokens are AES-256-GCM-encrypted (src/lib/crypto/encryption.ts),
-- mirroring the BYO-key pattern already used for `whatsapp_config`
-- and `ai_configs.api_key`. Settings-class table: admin+ only.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS google_connections (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  google_email           TEXT NOT NULL,
  access_token           TEXT NOT NULL, -- encrypted, short-lived, refreshed on demand
  refresh_token          TEXT NOT NULL, -- encrypted, long-lived
  token_expiry           TIMESTAMPTZ NOT NULL,
  scopes                 TEXT[] NOT NULL DEFAULT '{}',
  calendar_id            TEXT NOT NULL DEFAULT 'primary',
  sheet_id               TEXT,
  sheet_range            TEXT DEFAULT 'Sheet1!A:E',
  sheet_column_mapping   JSONB DEFAULT '{}'::jsonb, -- e.g. {"name":"A","phone":"B","email":"C","service":"D","notes":"E","status":"F"}
  sheet_last_synced_row  INTEGER NOT NULL DEFAULT 1,
  sheet_last_synced_at   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE google_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS google_connections_select ON google_connections;
CREATE POLICY google_connections_select ON google_connections FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS google_connections_modify ON google_connections;
CREATE POLICY google_connections_modify ON google_connections FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON google_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON google_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
