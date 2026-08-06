// ============================================================
// Two-stage AI lead outreach/qualification dispatcher.
//
// Placeholder for Phase 4 — the SMS webhook (Phase 3) already calls
// this on every inbound message so the wiring is in place, but the
// actual outreach/qualification logic (outreach-assistant.ts,
// qualification-assistant.ts, lead_outreach_state stage machine)
// lands in Phase 4. For now this only enforces the one invariant that
// must hold from day one: an opted-out contact is never re-engaged by
// automation.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export async function dispatchInboundToLeadOutreach(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
  _inboundBody: string,
): Promise<void> {
  const { data: contact } = await db
    .from('contacts')
    .select('do_not_contact')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (contact?.do_not_contact) {
    return;
  }

  // TODO(Phase 4): drive lead_outreach_state through
  // not_started → outreach_sent → qualifying → slot_offered → booked,
  // calling outreach-assistant.ts / qualification-assistant.ts as
  // appropriate. `conversationId` is threaded through now so that
  // wiring is a body-only change, not a call-site change.
  void conversationId;
}
