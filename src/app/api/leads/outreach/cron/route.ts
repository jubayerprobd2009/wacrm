import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sendInitialOutreach } from '@/lib/ai/lead-outreach-dispatch'

/**
 * Send the first outreach SMS to every lead that's ready for it:
 * `lead_status = 'new_lead'`, the account has SMS configured, and the
 * lead has never been enrolled in the outreach flow (no
 * `lead_outreach_state` row).
 *
 * This is what turns a freshly-synced Google Sheets row (Phase 5) into
 * an actual outbound text without any manual action — the sheets-sync
 * cron creates the contact, this cron picks it up on its next run.
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

  // Accounts with an active SMS config — no point scanning leads for
  // accounts that can't send yet.
  const { data: smsAccounts, error: smsErr } = await admin
    .from('sms_config')
    .select('account_id')
    .eq('is_active', true)

  if (smsErr) {
    console.error('[leads/outreach cron] sms_config scan failed:', smsErr.message)
    return NextResponse.json({ error: smsErr.message }, { status: 500 })
  }
  const accountIds = (smsAccounts ?? []).map((r) => r.account_id)
  if (accountIds.length === 0) return NextResponse.json({ sent: 0 })

  // New leads not yet enrolled — LEFT JOIN emulated via a NOT IN
  // subquery on lead_outreach_state.contact_id (small volumes; a
  // straightforward join would need a Postgres RPC, not worth it yet).
  const { data: enrolledRows } = await admin.from('lead_outreach_state').select('contact_id')
  const enrolledIds = new Set((enrolledRows ?? []).map((r) => r.contact_id))

  const { data: newLeads, error: leadsErr } = await admin
    .from('contacts')
    .select('id, account_id, user_id')
    .in('account_id', accountIds)
    .eq('lead_status', 'new_lead')
    .eq('do_not_contact', false)
    .limit(200) // cap per run — a huge Sheets import shouldn't blast hundreds of SMS in one tick

  if (leadsErr) {
    console.error('[leads/outreach cron] leads scan failed:', leadsErr.message)
    return NextResponse.json({ error: leadsErr.message }, { status: 500 })
  }

  const pending = (newLeads ?? []).filter((c) => !enrolledIds.has(c.id))
  if (pending.length === 0) return NextResponse.json({ sent: 0 })

  let sent = 0
  for (const lead of pending) {
    try {
      const conversationId = await findOrCreateConversation(admin, lead.account_id, lead.user_id, lead.id)
      if (!conversationId) continue
      await sendInitialOutreach(admin, lead.account_id, lead.id, conversationId)
      sent += 1
    } catch (err) {
      console.error(`[leads/outreach cron] failed for contact ${lead.id}:`, err)
    }
  }

  return NextResponse.json({ sent, scanned: pending.length })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function findOrCreateConversation(admin: any, accountId: string, userId: string, contactId: string) {
  const { data: existing } = await admin
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (existing) return existing.id as string

  const { data: created, error } = await admin
    .from('conversations')
    .insert({ account_id: accountId, user_id: userId, contact_id: contactId, channel: 'sms' })
    .select('id')
    .single()
  if (error) {
    console.error('[leads/outreach cron] conversation create failed:', error.message)
    return null
  }
  return created.id as string
}
