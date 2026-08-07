-- ============================================================
-- 048_whatsapp_unofficial_display_name
--
-- Adds a user-facing label for a WhatsApp Unofficial connection
-- (shown on the connected/disconnected card in Settings, e.g.
-- "NextCore BD"). Purely cosmetic — never read by any send/receive
-- path, only by the settings UI. Distinct from `instance_name`
-- (Evolution's internal, generated identifier) and `phone_number`
-- (only known once actually connected).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_unofficial_config
  ADD COLUMN IF NOT EXISTS display_name TEXT;
