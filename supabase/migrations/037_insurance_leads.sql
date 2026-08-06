-- ============================================================
-- 037_insurance_leads
--
-- Turns `contacts` into insurance leads: adds a lead-status pipeline,
-- an insurance-specific service field, a lead-source marker, and a
-- do-not-contact suppression flag.
--
-- Leads are contacts, not a parallel entity — a lead who books an
-- appointment is the same row throughout, and this mirrors how
-- `deals` already layers workflow state onto `contacts` rather than
-- forking identity. `do_not_contact` is kept as its own boolean
-- (independent of `lead_status`) so the SMS send path (migration 039)
-- can hard-gate on it regardless of what an automation later sets
-- `lead_status` to — defense in depth against a race where an
-- in-flight automation step re-sets status after an opt-out.
--
-- Also seeds a default "Insurance Leads" pipeline per account (one
-- stage per enum value) and a trigger that keeps the matching `deals`
-- row's stage in sync with `contacts.lead_status`, so the existing
-- Kanban UI becomes the visual lead board with no new component.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- TYPE
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lead_status_enum') THEN
    CREATE TYPE lead_status_enum AS ENUM (
      'new_lead',
      'message_sent',
      'customer_responded',
      'interested',
      'not_interested',
      'appointment_requested',
      'appointment_booked',
      'follow_up_needed',
      'do_not_contact'
    );
  END IF;
END $$;

-- ============================================================
-- CONTACTS — new columns
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_status lead_status_enum NOT NULL DEFAULT 'new_lead',
  ADD COLUMN IF NOT EXISTS insurance_service TEXT,
  ADD COLUMN IF NOT EXISTS lead_source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS do_not_contact_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_lead_status
  ON contacts(account_id, lead_status);

CREATE INDEX IF NOT EXISTS idx_contacts_do_not_contact
  ON contacts(account_id) WHERE do_not_contact;

-- No RLS changes needed — `contacts` already has membership-checked
-- SELECT/INSERT/UPDATE/DELETE policies from 017_account_sharing.sql
-- and RLS is row-level, not column-level.

-- ============================================================
-- DEFAULT "Insurance Leads" PIPELINE — one stage per lead_status
--
-- `ensure_insurance_leads_pipeline(account_id)` is idempotent and
-- self-healing: it creates the pipeline + stages on first call for an
-- account and just returns the existing pipeline id on every call
-- after. Called from two places:
--   1. the backfill loop right below, for every account that already
--      exists at migration time;
--   2. the sync trigger further down, so accounts created AFTER this
--      migration runs (i.e. every future signup) get the pipeline
--      lazily on their lead's first status change instead of never.
-- SECURITY DEFINER so the trigger (running as the authenticated
-- caller via RLS) can still create pipeline/stage rows.
-- ============================================================
CREATE OR REPLACE FUNCTION public.ensure_insurance_leads_pipeline(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pipeline UUID;
  v_stage_names TEXT[] := ARRAY[
    'New Lead', 'Message Sent', 'Customer Responded', 'Interested',
    'Not Interested', 'Appointment Requested', 'Appointment Booked',
    'Follow-Up Needed', 'Do Not Contact'
  ];
  v_stage_colors TEXT[] := ARRAY[
    '#64748b', '#3b82f6', '#06b6d4', '#22c55e',
    '#f97316', '#a855f7', '#16a34a', '#eab308', '#dc2626'
  ];
  i INTEGER;
BEGIN
  SELECT id INTO v_pipeline
  FROM pipelines
  WHERE account_id = p_account_id AND name = 'Insurance Leads'
  LIMIT 1;

  IF v_pipeline IS NOT NULL THEN
    RETURN v_pipeline;
  END IF;

  INSERT INTO pipelines (account_id, user_id, name)
  VALUES (p_account_id, (SELECT owner_user_id FROM accounts WHERE id = p_account_id), 'Insurance Leads')
  RETURNING id INTO v_pipeline;

  FOR i IN 1 .. array_length(v_stage_names, 1) LOOP
    INSERT INTO pipeline_stages (pipeline_id, name, position, color)
    VALUES (v_pipeline, v_stage_names[i], i - 1, v_stage_colors[i]);
  END LOOP;

  RETURN v_pipeline;
END;
$$;

ALTER FUNCTION public.ensure_insurance_leads_pipeline(UUID) OWNER TO postgres;

-- Backfill: every account that exists right now gets its pipeline
-- created immediately rather than waiting for a lead's first status
-- change (a fresh account should show the empty Kanban board today).
DO $$
DECLARE
  v_account_id UUID;
BEGIN
  FOR v_account_id IN SELECT id FROM accounts LOOP
    PERFORM public.ensure_insurance_leads_pipeline(v_account_id);
  END LOOP;
END $$;

-- ============================================================
-- SYNC TRIGGER — contacts.lead_status → deals.stage_id
--
-- Whenever a contact's lead_status changes, upsert a `deals` row in
-- that account's "Insurance Leads" pipeline and move it to the
-- matching stage (matched by name — see v_stage_names above). The
-- automation (Phase 4) only ever writes `contacts.lead_status`; it
-- never needs to know the pipeline's shape.
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_deal_stage_from_lead_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pipeline_id UUID;
  v_stage_id    UUID;
  v_stage_name  TEXT;
  v_deal_id     UUID;
BEGIN
  IF NEW.lead_status IS NOT DISTINCT FROM OLD.lead_status THEN
    RETURN NEW;
  END IF;

  v_pipeline_id := public.ensure_insurance_leads_pipeline(NEW.account_id);

  v_stage_name := CASE NEW.lead_status
    WHEN 'new_lead'               THEN 'New Lead'
    WHEN 'message_sent'           THEN 'Message Sent'
    WHEN 'customer_responded'     THEN 'Customer Responded'
    WHEN 'interested'             THEN 'Interested'
    WHEN 'not_interested'         THEN 'Not Interested'
    WHEN 'appointment_requested'  THEN 'Appointment Requested'
    WHEN 'appointment_booked'     THEN 'Appointment Booked'
    WHEN 'follow_up_needed'       THEN 'Follow-Up Needed'
    WHEN 'do_not_contact'         THEN 'Do Not Contact'
  END;

  SELECT id INTO v_stage_id
  FROM pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND name = v_stage_name;

  IF v_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_deal_id
  FROM deals
  WHERE account_id = NEW.account_id
    AND pipeline_id = v_pipeline_id
    AND contact_id = NEW.id
  LIMIT 1;

  IF v_deal_id IS NULL THEN
    INSERT INTO deals (account_id, user_id, pipeline_id, stage_id, contact_id, title)
    VALUES (
      NEW.account_id,
      (SELECT owner_user_id FROM accounts WHERE id = NEW.account_id),
      v_pipeline_id,
      v_stage_id,
      NEW.id,
      COALESCE(NULLIF(NEW.name, ''), NEW.phone)
    );
  ELSE
    UPDATE deals SET stage_id = v_stage_id, updated_at = NOW() WHERE id = v_deal_id;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_deal_stage_from_lead_status() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_sync_deal_stage_from_lead_status ON contacts;
CREATE TRIGGER trg_sync_deal_stage_from_lead_status
  AFTER UPDATE OF lead_status ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.sync_deal_stage_from_lead_status();
