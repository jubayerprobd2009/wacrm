import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { buildReminderMessage, loadSupportContact } from '@/lib/ai/confirmation'
import { sendSmsToConversation } from '@/lib/sms/send-message'

/**
 * Send a reminder SMS for every confirmed appointment starting in the
 * next 23-25 hours that hasn't had one yet. The 2-hour window (rather
 * than an exact 24h mark) is what makes an hourly cron tick safe to
 * use without missing appointments that fall between ticks.
 *
 * Same shared-secret auth pattern as the other cron routes.
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
  const now = Date.now()
  const windowStart = new Date(now + 23 * 60 * 60 * 1000).toISOString()
  const windowEnd = new Date(now + 25 * 60 * 60 * 1000).toISOString()

  const { data: due, error } = await admin
    .from('appointments')
    .select('id, account_id, contact_id, conversation_id, scheduled_start, scheduled_end, location_or_link, google_calendar_event_id, google_calendar_id')
    .eq('status', 'confirmed')
    .is('reminder_sent_at', null)
    .gte('scheduled_start', windowStart)
    .lte('scheduled_start', windowEnd)

  if (error) {
    console.error('[appointments/reminders cron] scan failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!due?.length) return NextResponse.json({ sent: 0 })

  let sent = 0
  for (const appt of due) {
    if (!appt.conversation_id) continue
    try {
      const { data: account } = await admin.from('accounts').select('name').eq('id', appt.account_id).maybeSingle()
      const companyName = account?.name || 'our team'
      const supportContact = await loadSupportContact(admin, appt.account_id)

      await sendSmsToConversation(admin, appt.account_id, {
        conversationId: appt.conversation_id,
        body: buildReminderMessage(appt, companyName, supportContact),
        isAutomated: true,
      })
      await admin.from('appointments').update({ reminder_sent_at: new Date().toISOString() }).eq('id', appt.id)
      sent += 1
    } catch (err) {
      console.error(`[appointments/reminders cron] failed for appointment ${appt.id}:`, err)
    }
  }

  return NextResponse.json({ sent, scanned: due.length })
}
