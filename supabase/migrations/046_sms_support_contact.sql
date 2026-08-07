-- ============================================================
-- 046_sms_support_contact
--
-- Adds an operator-configured "contact us" line (phone/email/etc.)
-- that gets appended to appointment confirmation and reminder SMS,
-- per the CRM spec's "contact information" confirmation field.
-- Plain text, not a secret — no encryption needed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE sms_config
  ADD COLUMN IF NOT EXISTS support_contact TEXT;
