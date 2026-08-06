-- ============================================================
-- 044_lead_offered_slots
--
-- Scratch space for the 2-3 Calendar slots offered to a lead during
-- the `slot_offered` stage (Phase 4b), so the dispatcher can match
-- the customer's free-text reply ("2", "the 10am one", "Tuesday
-- works") back to a concrete {start,end} pair without re-querying
-- Calendar or a second LLM call for every reply in that stage.
-- Cleared once the appointment is booked (or the lead re-enters
-- qualification for any reason).
-- ============================================================

ALTER TABLE lead_outreach_state
  ADD COLUMN IF NOT EXISTS offered_slots JSONB NOT NULL DEFAULT '[]'::jsonb;
