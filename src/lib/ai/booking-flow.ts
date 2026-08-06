// ============================================================
// Bridges the qualification assistant's "ready to book" signal to an
// actual Google Calendar booking. Used by lead-outreach-dispatch.ts
// once a lead's `lead_outreach_state.stage` reaches `slot_offered`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadGoogleConnection } from '@/lib/google/connection'
import { getAvailableSlots, createEvent, CalendarError, type TimeSlot } from '@/lib/google/calendar'
import type { QualificationData } from './qualification-assistant'

const SLOT_SEARCH_DAYS = 7
const APPOINTMENT_DURATION_MINUTES = 30

/**
 * Fetch up to 3 upcoming open slots and format them as a numbered SMS
 * list. Returns `null` when Google isn't connected for this account —
 * the caller falls back to "someone will follow up" instead.
 */
export async function offerSlots(
  db: SupabaseClient,
  accountId: string,
): Promise<{ slots: TimeSlot[]; message: string } | null> {
  const baseUrl = envBaseUrl()
  if (!baseUrl) return null
  const connection = await loadGoogleConnection(db, accountId, baseUrl)
  if (!connection) return null

  const rangeStart = new Date()
  rangeStart.setHours(rangeStart.getHours() + 2) // don't offer a slot starting in the next 2h
  const rangeEnd = new Date(rangeStart)
  rangeEnd.setDate(rangeEnd.getDate() + SLOT_SEARCH_DAYS)

  let slots: TimeSlot[]
  try {
    slots = await getAvailableSlots(connection.tokens, {
      rangeStart,
      rangeEnd,
      durationMinutes: APPOINTMENT_DURATION_MINUTES,
      maxSlots: 3,
    })
  } catch (err) {
    console.error('[booking-flow] getAvailableSlots failed:', err)
    return null
  }

  if (slots.length === 0) {
    return { slots: [], message: "I don't see any open times in the next week — someone from our team will reach out to find a time that works." }
  }

  const lines = slots.map((s, i) => `${i + 1}) ${formatSlot(s.start)}`)
  const message = `Great! Here are some times that work:\n${lines.join('\n')}\nReply with the number that works best for you.`
  return { slots, message }
}

/**
 * Parse a customer's free-text reply against the previously-offered
 * slot list. Deliberately simple (per the "keep it simple" brief): we
 * ask for a number 1-3 in the offer message, so matching the first
 * standalone digit 1-N in the reply covers the overwhelming majority
 * of real replies without a second LLM call.
 */
export function matchOfferedSlot(reply: string, offeredSlots: TimeSlot[]): TimeSlot | null {
  const match = reply.match(/\b([1-9])\b/)
  if (!match) return null
  const index = Number(match[1]) - 1
  return offeredSlots[index] ?? null
}

export interface BookAppointmentResult {
  appointmentId: string
  eventId: string
  meetLink: string | null
}

/**
 * Create the Calendar event + `appointments` row for a matched slot.
 * The DB-level double-booking guard is the unique index on
 * `appointments.google_calendar_event_id` (migration 038) plus this
 * function re-checking for an overlapping CONFIRMED appointment on
 * the same calendar immediately before calling Calendar — closing the
 * race where two leads pick the same last-open slot within seconds of
 * each other.
 */
export async function bookAppointment(
  db: SupabaseClient,
  accountId: string,
  args: {
    contactId: string
    conversationId: string
    slot: TimeSlot
    data: QualificationData
  },
): Promise<BookAppointmentResult | null> {
  const baseUrl = envBaseUrl()
  if (!baseUrl) return null
  const connection = await loadGoogleConnection(db, accountId, baseUrl)
  if (!connection) return null

  const { data: overlap } = await db
    .from('appointments')
    .select('id')
    .eq('account_id', accountId)
    .eq('status', 'confirmed')
    .lt('scheduled_start', args.slot.end)
    .gt('scheduled_end', args.slot.start)
    .maybeSingle()
  if (overlap) {
    return null // race lost — caller re-offers fresh slots
  }

  let event
  try {
    event = await createEvent(connection.tokens, {
      summary: `Insurance appointment — ${args.data.full_name ?? 'Lead'}`,
      description: [
        `Reason: ${args.data.reason ?? 'n/a'}`,
        `Insurance type: ${args.data.insurance_type ?? 'n/a'}`,
        `Phone: ${args.data.phone ?? 'n/a'}`,
        `Email: ${args.data.email ?? 'n/a'}`,
      ].join('\n'),
      start: args.slot.start,
      end: args.slot.end,
      attendeeEmail: args.data.email,
    })
  } catch (err) {
    console.error('[booking-flow] createEvent failed:', err instanceof CalendarError ? err.message : err)
    return null
  }

  const { data: appt, error } = await db
    .from('appointments')
    .insert({
      account_id: accountId,
      contact_id: args.contactId,
      conversation_id: args.conversationId,
      full_name: args.data.full_name ?? '',
      reason: args.data.reason,
      insurance_type: args.data.insurance_type,
      phone: args.data.phone ?? '',
      email: args.data.email,
      scheduled_start: args.slot.start,
      scheduled_end: args.slot.end,
      status: 'confirmed',
      google_calendar_event_id: event.eventId,
      google_calendar_id: connection.tokens.calendarId,
      location_or_link: event.meetLink,
    })
    .select('id')
    .single()

  if (error || !appt) {
    console.error('[booking-flow] appointments insert failed:', error)
    return null
  }

  return { appointmentId: appt.id, eventId: event.eventId, meetLink: event.meetLink }
}

function formatSlot(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// The Google OAuth2Client needs *a* redirect_uri to construct, even
// though nothing here redirects anyone — googleapis just requires the
// constructor param. The outreach dispatcher runs outside a request
// context (webhook `after()`, cron), so unlike the OAuth connect/
// callback routes (which derive it from request headers via
// getBaseUrl()), this requires the operator to set
// `NEXT_PUBLIC_SITE_URL` explicitly. Returns null (→ "Google not
// available") rather than throwing when it's unset, so a missing env
// var degrades to the manual-follow-up path instead of crashing the
// dispatcher.
function envBaseUrl(): string | null {
  return process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '') || null
}
