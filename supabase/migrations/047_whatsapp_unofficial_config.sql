-- ============================================================
-- 047_whatsapp_unofficial_config
--
-- WhatsApp "Unofficial" connection path (WaSenderAPI / Evolution
-- API) — a sibling to `whatsapp_config` (Meta), NOT a rework of it:
-- `whatsapp_config` has `UNIQUE(phone_number_id)` load-bearing for
-- the existing Meta webhook's tenant lookup (migration 013), and two
-- independently-connectable settings tabs ("WhatsApp Official" /
-- "WhatsApp Unofficial") map naturally to two tables.
--
-- `channel` on conversations/messages stays 'whatsapp' for both
-- providers (see 039_sms_config.sql for that column) — provider
-- lives on the config row, not on messages/conversations. This table
-- is intentionally NOT referenced by any query yet; the Providers-
-- phase agent wires `resolve.ts` to read from it.
--
-- RLS mirrors `sms_config` (039_sms_config.sql) exactly: member read,
-- admin write.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_unofficial_config (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,

  provider           TEXT NOT NULL CHECK (provider IN ('wasender', 'evolution')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('connected', 'disconnected', 'pending')),
  -- Explicit primary-sending switch (client's confirmed decision: no
  -- silent default when both Official and Unofficial are connected).
  is_primary         BOOLEAN NOT NULL DEFAULT false,

  -- Opaque per-account webhook path segment
  -- (/api/whatsapp/unofficial/{provider}/webhook/<inbound_token>) —
  -- tenancy is resolved by this token instead of a payload-embedded
  -- id, since neither unofficial provider reliably echoes one back.
  inbound_token      UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),

  phone_number       TEXT,
  connected_at       TIMESTAMPTZ,
  -- Drives a "webhook verified" checkmark in the UI.
  last_inbound_at    TIMESTAMPTZ,
  last_status_error  TEXT,

  -- ---- WaSenderAPI fields ----
  api_key            TEXT, -- AES-256-GCM-encrypted, see src/lib/crypto/encryption.ts
  webhook_secret     TEXT, -- AES-256-GCM-encrypted, see src/lib/crypto/encryption.ts

  -- ---- Evolution API fields ----
  base_url           TEXT,
  admin_api_key      TEXT, -- AES-256-GCM-encrypted, see src/lib/crypto/encryption.ts
  instance_name      TEXT,
  instance_token     TEXT, -- AES-256-GCM-encrypted, see src/lib/crypto/encryption.ts

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Evolution's webhook validates `body.instance` against this — mirrors
-- `whatsapp_config`'s `phone_number_id` uniqueness (migration 013).
-- Partial (WHERE NOT NULL) since WaSenderAPI rows never set it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_unofficial_config_instance_name
  ON whatsapp_unofficial_config(instance_name)
  WHERE instance_name IS NOT NULL;

ALTER TABLE whatsapp_unofficial_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_unofficial_config_select ON whatsapp_unofficial_config;
CREATE POLICY whatsapp_unofficial_config_select ON whatsapp_unofficial_config FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS whatsapp_unofficial_config_insert ON whatsapp_unofficial_config;
CREATE POLICY whatsapp_unofficial_config_insert ON whatsapp_unofficial_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_unofficial_config_update ON whatsapp_unofficial_config;
CREATE POLICY whatsapp_unofficial_config_update ON whatsapp_unofficial_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_unofficial_config_delete ON whatsapp_unofficial_config;
CREATE POLICY whatsapp_unofficial_config_delete ON whatsapp_unofficial_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_unofficial_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_unofficial_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- messages(conversation_id, message_id) — partial unique index
-- ============================================================
--
-- Currently just a plain index on `message_id` alone
-- (001_initial_schema.sql:178). Baileys-backed providers (WaSenderAPI/
-- Evolution) redeliver webhooks more aggressively than Meta, so the
-- shared inbound core needs a DB-level dedup guard scoped to
-- (conversation_id, message_id) rather than relying on every provider's
-- webhook handler remembering to de-dupe itself.
--
-- Safety: this block does NOT delete or modify any existing row. If
-- duplicate (conversation_id, message_id) pairs already exist, the
-- CREATE UNIQUE INDEX below fails loudly (migration aborts) rather
-- than silently dropping rows — surfacing a RAISE NOTICE with the
-- count first so the failure is diagnosable. An operator must dedupe
-- the offending rows by hand and re-run this migration.
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT conversation_id, message_id
    FROM messages
    WHERE message_id IS NOT NULL
    GROUP BY conversation_id, message_id
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE NOTICE 'messages: % duplicate (conversation_id, message_id) pair(s) found — the unique index below will fail to create until these are de-duplicated manually.', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id_unique
  ON messages(conversation_id, message_id)
  WHERE message_id IS NOT NULL;
