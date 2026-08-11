-- ============================================================
-- 051_outreach_channel_mode
--
-- Lets an account choose how the automated lead-outreach cron picks a
-- channel for the FIRST touch to a new lead:
--   - auto:          try WhatsApp first, fall back to SMS on failure/
--                     timeout (the default/recommended behavior).
--   - whatsapp_only: WhatsApp only, no SMS fallback.
--   - sms_only:      unchanged legacy behavior (SMS only).
--
-- outreach_whatsapp_template_name/_language: Meta's WhatsApp Cloud API
-- requires an APPROVED message template (not free text) to message a
-- lead who has never messaged in first. Only relevant when the
-- account's active WhatsApp connection is Meta ('official'); unofficial
-- (Evolution/WaSender) connections send free text and ignore these two
-- columns. See lead-outreach-dispatch.ts for how this is consumed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS outreach_channel_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_outreach_channel_mode_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_outreach_channel_mode_check
  CHECK (outreach_channel_mode IN ('auto', 'whatsapp_only', 'sms_only'));

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS outreach_whatsapp_template_name TEXT;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS outreach_whatsapp_template_language TEXT NOT NULL DEFAULT 'en_US';
