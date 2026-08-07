// ============================================================
// Appointment confirmation + reminder SMS content, and the
// reschedule/cancel keyword handling for a `booked` lead replying
// back in the same thread.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadGoogleConnection } from '@/lib/google/connection'
import { cancelEvent, CalendarError } from '@/lib/google/calendar'
import { sendSmsToConversation } from '@/lib/sms/send-message'

export interface AppointmentRow {
  id: string
  scheduled_start: string
  scheduled_end: string
  location_or_link: string | null
  google_calendar_event_id: string | null
  google_calendar_id: string | null
}

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  return {
    date: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
  }
}

export function buildConfirmationMessage(
  appt: AppointmentRow,
  companyName: string,
  supportContact?: string | null,
): string {
  const { date, time } = formatDateTime(appt.scheduled_start)
  const where = appt.location_or_link ? `\nWhere: ${appt.location_or_link}` : ''
  const contact = supportContact?.trim() ? `\nQuestions? Contact us: ${supportContact.trim()}` : ''
  return (
    `You're confirmed with ${companyName}!\n` +
    `${date} at ${time}${where}${contact}\n\n` +
    `Reply RESCHEDULE to pick a different time, or CANCEL to cancel.`
  )
}

export function buildReminderMessage(
  appt: AppointmentRow,
  companyName: string,
  supportContact?: string | null,
): string {
  const { date, time } = formatDateTime(appt.scheduled_start)
  const where = appt.location_or_link ? `\nWhere: ${appt.location_or_link}` : ''
  const contact = supportContact?.trim() ? `\nQuestions? Contact us: ${supportContact.trim()}` : ''
  return (
    `Reminder: your appointment with ${companyName} is ${date} at ${time}.${where}${contact}\n\n` +
    `Reply RESCHEDULE or CANCEL if you need to make a change.`
  )
}

/** The operator-configured "contact us" line (Settings -> SMS ->
 *  Support contact), appended to confirmation/reminder SMS. */
export async function loadSupportContact(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await db
    .from('sms_config')
    .select('support_contact')
    .eq('account_id', accountId)
    .maybeSingle()
  return data?.support_contact ?? null
}

/** Send the confirmation and mark `confirmation_sent_at`. Best-effort
 *  — a failure here shouldn't undo the booking, just gets logged. */
export async function sendConfirmation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  appt: AppointmentRow,
  companyName: string,
): Promise<void> {
  try {
    const supportContact = await loadSupportContact(db, accountId)
    await sendSmsToConversation(db, accountId, {
      conversationId,
      body: buildConfirmationMessage(appt, companyName, supportContact),
      isAutomated: true,
    })
    await db.from('appointments').update({ confirmation_sent_at: new Date().toISOString() }).eq('id', appt.id)
  } catch (err) {
    console.error('[confirmation] failed to send confirmation SMS:', err)
  }
}

const CANCEL_KEYWORDS = /\bcancel\b/i
const RESCHEDULE_KEYWORDS = /\bresched/i

export type BookedReplyIntent = 'cancel' | 'reschedule' | 'other'

export function detectBookedReplyIntent(reply: string): BookedReplyIntent {
  if (CANCEL_KEYWORDS.test(reply)) return 'cancel'
  if (RESCHEDULE_KEYWORDS.test(reply)) return 'reschedule'
  return 'other'
}

/** Cancel the appointment: Calendar event + DB row + notify. Used by
 *  both the CANCEL keyword path and (indirectly, by deleting first)
 *  the RESCHEDULE path. */
export async function cancelAppointment(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  appt: AppointmentRow,
): Promise<void> {
  if (appt.google_calendar_event_id) {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
      if (baseUrl) {
        const connection = await loadGoogleConnection(db, accountId, baseUrl)
        if (connection) {
          await cancelEvent(connection.tokens, appt.google_calendar_event_id)
        }
      }
    } catch (err) {
      console.error('[confirmation] cancelEvent failed:', err instanceof CalendarError ? err.message : err)
      // Still cancel our own record — an orphaned Calendar event is a
      // smaller problem than a customer who thinks they cancelled but
      // is still on the books.
    }
  }

  await db
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appt.id)

  await sendSmsToConversation(db, accountId, {
    conversationId,
    body: "You're all set — that appointment has been cancelled. Text us anytime if you'd like to book again.",
    isAutomated: true,
  })
}
