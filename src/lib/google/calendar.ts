// ============================================================
// Google Calendar — availability checking + appointment booking.
//
// Every function takes the account's decrypted `google_connections`
// row (tokens already decrypted by the caller, mirroring how
// send-message.ts decrypts sms_config before calling twilio-api.ts)
// plus an `onRefreshed` callback so a refreshed access token gets
// persisted without this module needing its own DB client.
// ============================================================

import { google } from 'googleapis'
import { getAuthorizedClient } from './oauth'

export class CalendarError extends Error {
  readonly status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'CalendarError'
    this.status = status
  }
}

export interface GoogleConnectionTokens {
  baseUrl: string
  accessToken: string
  refreshToken: string
  expiryDate: number
  calendarId: string
  onRefreshed?: (tokens: { accessToken: string; expiryDate: number }) => Promise<void>
}

async function calendarClient(tokens: GoogleConnectionTokens) {
  const auth = await getAuthorizedClient(tokens)
  return google.calendar({ version: 'v3', auth })
}

export interface TimeSlot {
  start: string // ISO 8601
  end: string
}

/**
 * Compute open slots of `durationMinutes` within [rangeStart,
 * rangeEnd), during `businessHours` (local hour-of-day, e.g. 9-17),
 * skipping weekends and any Freebusy-reported conflict. Returns at
 * most `maxSlots` — the qualification assistant only ever offers 2-3
 * to the customer via SMS.
 */
export async function getAvailableSlots(
  tokens: GoogleConnectionTokens,
  args: {
    rangeStart: Date
    rangeEnd: Date
    durationMinutes: number
    businessHours?: { startHour: number; endHour: number }
    maxSlots?: number
  },
): Promise<TimeSlot[]> {
  const { rangeStart, rangeEnd, durationMinutes, maxSlots = 3 } = args
  const { startHour, endHour } = args.businessHours ?? { startHour: 9, endHour: 17 }

  const client = await calendarClient(tokens)

  let freeBusy
  try {
    freeBusy = await client.freebusy.query({
      requestBody: {
        timeMin: rangeStart.toISOString(),
        timeMax: rangeEnd.toISOString(),
        items: [{ id: tokens.calendarId }],
      },
    })
  } catch (err) {
    throw new CalendarError(
      `Failed to check calendar availability: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const busy = (freeBusy.data.calendars?.[tokens.calendarId]?.busy ?? []).map((b) => ({
    start: new Date(b.start!).getTime(),
    end: new Date(b.end!).getTime(),
  }))

  const slots: TimeSlot[] = []
  const durationMs = durationMinutes * 60_000
  const cursor = new Date(rangeStart)
  cursor.setMinutes(0, 0, 0)

  while (cursor < rangeEnd && slots.length < maxSlots) {
    const day = cursor.getDay()
    const hour = cursor.getHours()
    const isWeekend = day === 0 || day === 6
    const inBusinessHours = hour >= startHour && hour < endHour

    if (!isWeekend && inBusinessHours && cursor >= rangeStart) {
      const slotStart = cursor.getTime()
      const slotEnd = slotStart + durationMs
      const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start)
      if (!overlaps) {
        slots.push({ start: new Date(slotStart).toISOString(), end: new Date(slotEnd).toISOString() })
      }
    }

    cursor.setMinutes(cursor.getMinutes() + 30) // 30-minute grid
  }

  return slots
}

export interface CreateEventArgs {
  summary: string
  description: string
  start: string // ISO 8601
  end: string
  attendeeEmail?: string | null
  location?: string | null
}

export interface CreatedEvent {
  eventId: string
  htmlLink: string | null
  meetLink: string | null
}

/**
 * Create the calendar event. Callers (lead-outreach-dispatch /
 * booking flow, Phase 4b wiring) are responsible for the DB-level
 * double-booking guard (checking `appointments` for an overlapping
 * row before calling this) — Calendar's own Freebusy data can be
 * stale by the few seconds between offering a slot and the customer
 * picking it, so this is belt-and-suspenders, not the only guard.
 */
export async function createEvent(
  tokens: GoogleConnectionTokens,
  args: CreateEventArgs,
): Promise<CreatedEvent> {
  const client = await calendarClient(tokens)

  try {
    const res = await client.events.insert({
      calendarId: tokens.calendarId,
      requestBody: {
        summary: args.summary,
        description: args.description,
        start: { dateTime: args.start },
        end: { dateTime: args.end },
        attendees: args.attendeeEmail ? [{ email: args.attendeeEmail }] : undefined,
        location: args.location ?? undefined,
      },
    })

    if (!res.data.id) {
      throw new CalendarError('Google Calendar returned no event id')
    }

    return {
      eventId: res.data.id,
      htmlLink: res.data.htmlLink ?? null,
      meetLink: res.data.hangoutLink ?? null,
    }
  } catch (err) {
    if (err instanceof CalendarError) throw err
    throw new CalendarError(
      `Failed to create calendar event: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function cancelEvent(tokens: GoogleConnectionTokens, eventId: string): Promise<void> {
  const client = await calendarClient(tokens)
  try {
    await client.events.delete({ calendarId: tokens.calendarId, eventId })
  } catch (err) {
    throw new CalendarError(
      `Failed to cancel calendar event: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function rescheduleEvent(
  tokens: GoogleConnectionTokens,
  eventId: string,
  newStart: string,
  newEnd: string,
): Promise<void> {
  const client = await calendarClient(tokens)
  try {
    await client.events.patch({
      calendarId: tokens.calendarId,
      eventId,
      requestBody: { start: { dateTime: newStart }, end: { dateTime: newEnd } },
    })
  } catch (err) {
    throw new CalendarError(
      `Failed to reschedule calendar event: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
