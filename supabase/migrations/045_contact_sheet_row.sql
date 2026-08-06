-- ============================================================
-- 045_contact_sheet_row
--
-- Tracks which Google Sheet row a contact was synced from, so the
-- Phase 5 status write-back (sheets-writeback.ts) can update the
-- exact row directly instead of re-searching the sheet by phone on
-- every lead_status change.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS sheet_row_number INTEGER;
