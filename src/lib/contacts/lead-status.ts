// ============================================================
// Single chokepoint for changing a contact's `lead_status` from
// automation code (the outreach dispatcher, confirmation/cancel
// flow, the SMS webhook's opt-out handler). Every write goes through
// here so the Sheets status write-back (Phase 5, client-requested
// two-way sync) can never be forgotten at a call site — mirrors why
// `do_not_contact` gating lives in one place in send-message.ts
// rather than being re-checked ad hoc.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { writeBackLeadStatus } from '@/lib/google/sheets-writeback'

function envBaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') || null
}

export async function updateLeadStatus(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  leadStatus: string,
): Promise<void> {
  await db.from('contacts').update({ lead_status: leadStatus }).eq('id', contactId)

  const baseUrl = envBaseUrl()
  if (baseUrl) {
    // Fire-and-forget from the caller's point of view — best-effort,
    // never throws (see writeBackLeadStatus), but awaited here so a
    // background job (cron, webhook after()) doesn't exit before it
    // finishes.
    await writeBackLeadStatus(db, accountId, contactId, leadStatus, baseUrl)
  }
}
