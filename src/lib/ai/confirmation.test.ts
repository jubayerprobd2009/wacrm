import { describe, expect, it } from 'vitest'
import { buildConfirmationMessage, buildReminderMessage, detectBookedReplyIntent, type AppointmentRow } from './confirmation'

const APPT: AppointmentRow = {
  id: 'appt-1',
  scheduled_start: '2026-08-10T18:00:00.000Z',
  scheduled_end: '2026-08-10T18:30:00.000Z',
  location_or_link: 'https://meet.google.com/abc-defg-hij',
  google_calendar_event_id: 'evt-1',
  google_calendar_id: 'primary',
}

describe('buildConfirmationMessage', () => {
  it('includes the date, time, location, and reschedule/cancel instructions', () => {
    const msg = buildConfirmationMessage(APPT, 'Acme Insurance')
    expect(msg).toContain('Acme Insurance')
    expect(msg).toContain('meet.google.com/abc-defg-hij')
    expect(msg).toContain('RESCHEDULE')
    expect(msg).toContain('CANCEL')
  })

  it('omits the "Where" line when there is no location', () => {
    const msg = buildConfirmationMessage({ ...APPT, location_or_link: null }, 'Acme Insurance')
    expect(msg).not.toContain('Where:')
  })

  it('includes the support contact line when configured', () => {
    const msg = buildConfirmationMessage(APPT, 'Acme Insurance', '(555) 123-4567')
    expect(msg).toContain('Questions? Contact us: (555) 123-4567')
  })

  it('omits the contact line when support contact is not configured', () => {
    const msg = buildConfirmationMessage(APPT, 'Acme Insurance', null)
    expect(msg).not.toContain('Questions? Contact us')
  })
})

describe('buildReminderMessage', () => {
  it('includes the date, time, and reschedule/cancel instructions', () => {
    const msg = buildReminderMessage(APPT, 'Acme Insurance')
    expect(msg).toContain('Reminder')
    expect(msg).toContain('Acme Insurance')
    expect(msg).toContain('RESCHEDULE')
  })
})

describe('detectBookedReplyIntent', () => {
  it('detects cancel', () => {
    expect(detectBookedReplyIntent('please cancel my appointment')).toBe('cancel')
    expect(detectBookedReplyIntent('CANCEL')).toBe('cancel')
  })

  it('detects reschedule (including "reschedule" and "resched")', () => {
    expect(detectBookedReplyIntent('can I reschedule?')).toBe('reschedule')
    expect(detectBookedReplyIntent('need to resched')).toBe('reschedule')
  })

  it('returns other for anything else', () => {
    expect(detectBookedReplyIntent('see you then!')).toBe('other')
    expect(detectBookedReplyIntent('what should I bring?')).toBe('other')
  })

  it('prefers cancel when both keywords somehow appear', () => {
    expect(detectBookedReplyIntent('cancel, actually let me reschedule instead')).toBe('cancel')
  })
})
