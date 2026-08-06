-- ============================================================
-- 041_lead_ai_state
--
-- Per-lead automation cursor for the two-stage AI outreach/
-- qualification flow (Phase 4). Distinct from `contacts.lead_status`
-- (the human-facing CRM status): this is the AI dispatcher's internal
-- state machine, plus a scratch space for partially-collected
-- booking fields as the qualification assistant extracts them turn
-- by turn.
--
-- Service-role-owned, like `automation_pending_executions` and
-- `flow_runs` — the outreach dispatcher (not end users) drives this,
-- so there is no client INSERT/UPDATE/DELETE policy, only SELECT for
-- visibility/debugging.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_outreach_state (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id     UUID REFERENCES conversations(id) ON DELETE SET NULL,
  stage               TEXT NOT NULL DEFAULT 'not_started'
                         CHECK (stage IN (
                           'not_started', 'outreach_sent', 'awaiting_reply',
                           'qualifying', 'slot_offered', 'booked',
                           'opted_out', 'handed_off'
                         )),
  outreach_attempts   INTEGER NOT NULL DEFAULT 0,
  last_outreach_at    TIMESTAMPTZ,
  qualification_data  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_outreach_one_per_contact
  ON lead_outreach_state(account_id, contact_id);

ALTER TABLE lead_outreach_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_outreach_state_select ON lead_outreach_state;
CREATE POLICY lead_outreach_state_select ON lead_outreach_state FOR SELECT
  USING (is_account_member(account_id));
-- Service-role driven; no client INSERT/UPDATE/DELETE.

DROP TRIGGER IF EXISTS set_updated_at ON lead_outreach_state;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_outreach_state
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
