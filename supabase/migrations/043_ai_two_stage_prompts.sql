-- ============================================================
-- 043_ai_two_stage_prompts
--
-- Adds independently-editable system prompts for the two-stage lead
-- flow (Phase 4): `outreach_system_prompt` (stage 1 — introduce the
-- company, gauge interest) and `qualification_system_prompt` (stage 2
-- — collect booking details once a lead says yes). Kept separate from
-- the existing `system_prompt` (used by WhatsApp draft/auto-reply)
-- rather than overloading it, since an account may want very
-- different tone/content for "cold outreach" vs "booking a WhatsApp
-- customer support reply."
--
-- Also widens `ai_usage_log.mode`'s CHECK to accept the two new modes
-- so `logAiUsage` can record outreach/qualification token spend
-- alongside the existing auto_reply/draft rows.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS outreach_system_prompt TEXT,
  ADD COLUMN IF NOT EXISTS qualification_system_prompt TEXT;

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'lead_outreach', 'lead_qualification'));
