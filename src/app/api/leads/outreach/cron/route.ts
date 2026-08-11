import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendInitialOutreach, fallbackToSmsIfNeeded } from '@/lib/ai/lead-outreach-dispatch'
import { decideInitialOutreachChannel, type OutreachChannelMode } from '@/lib/ai/outreach-channel'

/**
 * Send the first outreach touch to every lead that's ready for it:
 * `lead_status = 'new_lead'`, the account has AI enabled, and the
 * lead has never been enrolled in the outreach flow (no
 * `lead_outreach_state` row). The channel (WhatsApp vs SMS) is decided
 * per-lead by `decideInitialOutreachChannel`, based on the account's
 * `outreach_channel_mode` setting and what's actually connected.
 *
 * This is what turns a freshly-imported/synced contact into an actual
 * outbound message without any manual action — a CSV/Excel import or
 * the Sheets-sync cron creates the contact, this cron picks it up on
 * its next run.
 *
 * A second pass in the same run sweeps `lead_outreach_state` rows
 * whose WhatsApp-first attempt has gone unconfirmed for too long
 * (no delivery-status webhook arrived) and falls them back to SMS —
 * this is what guarantees a lead is never left permanently unmessaged
 * when WhatsApp neither confirms nor explicitly fails.
 *
 * Auth: same shared-secret pattern as `/api/flows/cron` and
 * `/api/automations/cron` (`AUTOMATION_CRON_SECRET`, constant-time
 * compare). Hosting: Vercel Cron, a VPS crontab, or any external
 * pinger can hit this on a schedule — every 5-15 minutes is plenty
 * for a sales-outreach use case.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  const sent = await sendNewLeadOutreach(admin)
  const fallbackSent = await sweepStalledWhatsAppOutreach(admin)

  return NextResponse.json({ sent: sent.sent, scanned: sent.scanned, fallbackSent })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendNewLeadOutreach(admin: any): Promise<{ sent: number; scanned: number }> {
  // Accounts with AI enabled — outreach needs AI either way to draft
  // the message, regardless of which channel ends up sending it. This
  // also covers WhatsApp-only accounts (no SMS configured), which the
  // old SMS-only prefilter here used to skip entirely.
  const { data: aiAccounts, error: aiErr } = await admin
    .from('ai_configs')
    .select('account_id, outreach_channel_mode')
    .eq('is_active', true)

  if (aiErr) {
    console.error('[leads/outreach cron] ai_configs scan failed:', aiErr.message)
    return { sent: 0, scanned: 0 }
  }
  const accountIds = (aiAccounts ?? []).map((r: { account_id: string }) => r.account_id)
  if (accountIds.length === 0) return { sent: 0, scanned: 0 }
  const modeByAccount = new Map<string, OutreachChannelMode>(
    (aiAccounts ?? []).map((r: { account_id: string; outreach_channel_mode: OutreachChannelMode }) => [
      r.account_id,
      r.outreach_channel_mode,
    ]),
  )

  // New leads not yet enrolled — LEFT JOIN emulated via a NOT IN
  // subquery on lead_outreach_state.contact_id (small volumes; a
  // straightforward join would need a Postgres RPC, not worth it yet).
  const { data: enrolledRows } = await admin.from('lead_outreach_state').select('contact_id')
  const enrolledIds = new Set((enrolledRows ?? []).map((r: { contact_id: string }) => r.contact_id))

  const { data: newLeads, error: leadsErr } = await admin
    .from('contacts')
    .select('id, account_id, user_id')
    .in('account_id', accountIds)
    .eq('lead_status', 'new_lead')
    .eq('do_not_contact', false)
    .limit(200) // cap per run — a huge import shouldn't blast hundreds of messages in one tick

  if (leadsErr) {
    console.error('[leads/outreach cron] leads scan failed:', leadsErr.message)
    return { sent: 0, scanned: 0 }
  }

  const pending = (newLeads ?? []).filter((c: { id: string }) => !enrolledIds.has(c.id))
  if (pending.length === 0) return { sent: 0, scanned: 0 }

  let sent = 0
  for (const lead of pending) {
    try {
      const mode = modeByAccount.get(lead.account_id) ?? 'auto'
      const decision = await decideInitialOutreachChannel(admin, lead.account_id, mode)
      if (!decision.channel) continue // nothing usable connected for this account

      const conversationId = await findOrCreateConversation(
        admin,
        lead.account_id,
        lead.user_id,
        lead.id,
        decision.channel,
      )
      if (!conversationId) continue
      await sendInitialOutreach(
        admin,
        lead.account_id,
        lead.id,
        conversationId,
        decision.channel,
        decision.activeWhatsAppProvider,
      )
      sent += 1
    } catch (err) {
      console.error(`[leads/outreach cron] failed for contact ${lead.id}:`, err)
    }
  }

  return { sent, scanned: pending.length }
}

/** Minutes a WhatsApp-first attempt can go without a delivery-status
 *  update before the sweep falls it back to SMS. */
const STALL_WINDOW_MINUTES = 10

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sweepStalledWhatsAppOutreach(admin: any): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALL_WINDOW_MINUTES * 60_000).toISOString()

  const { data: stalledWa, error } = await admin
    .from('lead_outreach_state')
    .select('id, account_id, contact_id, conversation_id, outreach_message_id')
    .eq('outreach_channel_attempted', 'whatsapp')
    .is('sms_fallback_sent_at', null)
    .lt('last_outreach_at', staleCutoff)
    .limit(200)

  if (error) {
    console.error('[leads/outreach cron] stalled-WhatsApp sweep scan failed:', error.message)
    return 0
  }

  let fallbackSent = 0
  for (const row of stalledWa ?? []) {
    try {
      if (await fallbackToSmsIfNeeded(admin, row)) fallbackSent += 1
    } catch (err) {
      console.error(`[leads/outreach cron] fallback sweep failed for ${row.contact_id}:`, err)
    }
  }
  return fallbackSent
}

async function findOrCreateConversation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  accountId: string,
  userId: string,
  contactId: string,
  channel: 'whatsapp' | 'sms',
) {
  const { data: existing } = await admin
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  // Leave an existing conversation's channel as-is — it may already be
  // mid-thread on a different channel from a manual agent action.
  if (existing) return existing.id as string

  const { data: created, error } = await admin
    .from('conversations')
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId, channel })
    .select('id')
    .single()
  if (error) {
    console.error('[leads/outreach cron] conversation create failed:', error.message)
    return null
  }
  return created.id as string
}
