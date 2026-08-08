-- ============================================================
-- 049_ai_openrouter_and_toggles
--
-- (A1) Adds 'openrouter' as a third AI provider alongside the existing
-- 'openai'/'anthropic' — widens the CHECK constraint on both
-- ai_configs.provider (029_ai_reply.sql) and ai_usage_log.provider
-- (033_ai_reply_polish.sql), which are two independent constraints.
--
-- (B1/B5) Two configurable toggles, both defaulting to the safer/
-- recommended behavior — client's explicit instruction: ship real
-- judgment calls as a setting with a sensible default rather than
-- hardcoding one way, so they can self-serve the change later:
--   - ai_self_discloses: whether the assistant identifies itself as an
--     AI when asked (the client's own business document gave
--     conflicting instructions on this across different touchpoints).
--   - opt_out_applies_to_whatsapp: whether the opt-out phrase-list
--     check (see the SMS webhook) also runs on inbound WhatsApp
--     messages, not just SMS.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'openrouter'));

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS ai_self_discloses BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS opt_out_applies_to_whatsapp BOOLEAN NOT NULL DEFAULT true;
