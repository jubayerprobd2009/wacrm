// ============================================================
// outreach-channel.ts — decides which channel (WhatsApp or SMS) the
// automated lead-outreach cron should try FIRST for a given account's
// new leads, based on the account's `outreach_channel_mode` setting
// (see migration 051) and what's actually connected right now.
//
// Deliberately cheap — reuses `getConnectionSummary` from
// providers/resolve.ts (no live provider API calls) so it's safe to
// call once per pending lead on every cron tick.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { getConnectionSummary } from '@/lib/whatsapp/providers/resolve';
import type { WhatsAppProviderId } from '@/types';

export type OutreachChannelMode = 'auto' | 'whatsapp_only' | 'sms_only';

export interface OutreachChannelDecision {
  channel: 'whatsapp' | 'sms' | null;
  /** Only meaningful when `channel === 'whatsapp'`. */
  activeWhatsAppProvider: WhatsAppProviderId | null;
}

async function isSmsActive(db: SupabaseClient, accountId: string): Promise<boolean> {
  const { data } = await db
    .from('sms_config')
    .select('is_active')
    .eq('account_id', accountId)
    .maybeSingle();
  return !!data?.is_active;
}

/**
 * Decide the channel for a new lead's first outreach touch.
 *   - 'sms_only'      -> SMS if configured, else null (nothing usable).
 *   - 'whatsapp_only' -> WhatsApp if connected, else null (no SMS
 *                        fallback in this mode by design).
 *   - 'auto'          -> WhatsApp if connected, else SMS if configured,
 *                        else null.
 */
export async function decideInitialOutreachChannel(
  db: SupabaseClient,
  accountId: string,
  mode: OutreachChannelMode,
): Promise<OutreachChannelDecision> {
  if (mode === 'sms_only') {
    const smsActive = await isSmsActive(db, accountId);
    return { channel: smsActive ? 'sms' : null, activeWhatsAppProvider: null };
  }

  const summary = await getConnectionSummary(db, accountId);

  if (mode === 'whatsapp_only') {
    return summary.connected
      ? { channel: 'whatsapp', activeWhatsAppProvider: summary.active_provider }
      : { channel: null, activeWhatsAppProvider: null };
  }

  // auto
  if (summary.connected) {
    return { channel: 'whatsapp', activeWhatsAppProvider: summary.active_provider };
  }
  const smsActive = await isSmsActive(db, accountId);
  return { channel: smsActive ? 'sms' : null, activeWhatsAppProvider: null };
}
