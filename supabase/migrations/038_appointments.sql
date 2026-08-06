-- ============================================================
-- 038_appointments
--
-- Insurance appointment bookings, collected by the AI qualification
-- assistant (Phase 4) and booked against Google Calendar (Phase 4b).
-- RLS mirrors `deals`: agent+ (renamed to manager+ in migration 042)
-- can read/write, admin+ can delete.
-- ============================================================

CREATE TABLE IF NOT EXISTS appointments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id               UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id          UUID REFERENCES conversations(id) ON DELETE SET NULL,
  full_name                TEXT NOT NULL,
  reason                   TEXT,
  insurance_type           TEXT,
  phone                    TEXT NOT NULL,
  email                    TEXT,
  scheduled_start          TIMESTAMPTZ NOT NULL,
  scheduled_end            TIMESTAMPTZ NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed', 'no_show', 'rescheduled')),
  google_calendar_event_id TEXT,
  google_calendar_id       TEXT,
  location_or_link         TEXT,
  reminder_sent_at         TIMESTAMPTZ,
  confirmation_sent_at     TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scheduled_end > scheduled_start)
);

CREATE INDEX IF NOT EXISTS idx_appointments_account ON appointments(account_id);
CREATE INDEX IF NOT EXISTS idx_appointments_contact ON appointments(contact_id);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled_start ON appointments(account_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments(scheduled_start) WHERE status = 'confirmed' AND reminder_sent_at IS NULL;

-- One CRM appointment per Calendar event — also the backstop the
-- double-booking guard relies on when creating an event concurrently
-- for the same slot (see src/lib/google/calendar.ts, Phase 4b).
CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_calendar_event
  ON appointments(google_calendar_event_id) WHERE google_calendar_event_id IS NOT NULL;

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS appointments_insert ON appointments;
CREATE POLICY appointments_insert ON appointments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS appointments_update ON appointments;
CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS appointments_delete ON appointments;
CREATE POLICY appointments_delete ON appointments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON appointments;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
