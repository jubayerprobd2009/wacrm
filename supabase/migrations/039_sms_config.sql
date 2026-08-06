-- ============================================================
-- 039_sms_config
--
-- Twilio SMS integration config, mirroring `whatsapp_config`
-- (settings-class table, admin+ read/write, one row per account).
--
-- Also adds a `channel` column to `conversations`/`messages` instead
-- of a parallel SMS conversations table, so the existing inbox UI, AI
-- auto-reply plumbing, and RLS all work for SMS threads unchanged —
-- only the channel tag differs.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_config (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  twilio_account_sid    TEXT NOT NULL,
  twilio_auth_token     TEXT NOT NULL, -- AES-256-GCM-encrypted, see src/lib/crypto/encryption.ts
  twilio_phone_number   TEXT NOT NULL,
  messaging_service_sid TEXT,          -- optional: enables Twilio's built-in Advanced Opt-Out
  is_active             BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sms_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_config_select ON sms_config;
CREATE POLICY sms_config_select ON sms_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS sms_config_insert ON sms_config;
CREATE POLICY sms_config_insert ON sms_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sms_config_update ON sms_config;
CREATE POLICY sms_config_update ON sms_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS sms_config_delete ON sms_config;
CREATE POLICY sms_config_delete ON sms_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON sms_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sms_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- CHANNEL TAG — conversations / messages
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms'));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms'));

CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(account_id, channel);
