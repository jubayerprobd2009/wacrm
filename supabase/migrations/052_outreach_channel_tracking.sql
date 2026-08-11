-- ============================================================
-- 052_outreach_channel_tracking
--
-- Tracks which channel the FIRST outreach touch used and whether an
-- SMS fallback has already fired, so the WhatsApp-delivery-status
-- webhook and the outreach cron's timeout sweep can never send both
-- WhatsApp AND SMS for the same lead's first message (dedup guard),
-- and so a lead is never left permanently unmessaged when WhatsApp
-- neither confirms delivery nor explicitly fails.
--
-- outreach_message_id references the `messages` row created for the
-- initial-outreach send (whichever channel), so both the webhook
-- handler and the cron's timeout sweep can look up that ONE message's
-- current `status` directly instead of guessing from conversation
-- history.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE lead_outreach_state
  ADD COLUMN IF NOT EXISTS outreach_channel_attempted TEXT;

ALTER TABLE lead_outreach_state DROP CONSTRAINT IF EXISTS lead_outreach_state_outreach_channel_attempted_check;
ALTER TABLE lead_outreach_state ADD CONSTRAINT lead_outreach_state_outreach_channel_attempted_check
  CHECK (outreach_channel_attempted IN ('whatsapp', 'sms'));

ALTER TABLE lead_outreach_state
  ADD COLUMN IF NOT EXISTS outreach_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE lead_outreach_state
  ADD COLUMN IF NOT EXISTS whatsapp_failed_at TIMESTAMPTZ;

ALTER TABLE lead_outreach_state
  ADD COLUMN IF NOT EXISTS sms_fallback_sent_at TIMESTAMPTZ;

-- Keeps the cron's timeout-sweep query cheap — only scans rows that are
-- still-pending WhatsApp-first attempts with no fallback yet.
CREATE INDEX IF NOT EXISTS idx_lead_outreach_state_wa_pending
  ON lead_outreach_state (last_outreach_at)
  WHERE outreach_channel_attempted = 'whatsapp' AND sms_fallback_sent_at IS NULL;
