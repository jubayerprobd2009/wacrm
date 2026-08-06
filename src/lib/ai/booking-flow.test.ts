import { describe, expect, it } from 'vitest'
import { matchOfferedSlot } from './booking-flow'
import type { TimeSlot } from '@/lib/google/calendar'

const SLOTS: TimeSlot[] = [
  { start: '2026-08-10T14:00:00.000Z', end: '2026-08-10T14:30:00.000Z' },
  { start: '2026-08-11T10:00:00.000Z', end: '2026-08-11T10:30:00.000Z' },
  { start: '2026-08-12T15:00:00.000Z', end: '2026-08-12T15:30:00.000Z' },
]

describe('matchOfferedSlot', () => {
  it('matches a bare digit reply', () => {
    expect(matchOfferedSlot('2', SLOTS)).toEqual(SLOTS[1])
  })

  it('matches a digit embedded in a sentence', () => {
    expect(matchOfferedSlot('Ill take option 3 please', SLOTS)).toEqual(SLOTS[2])
  })

  it('returns null when no digit is present', () => {
    expect(matchOfferedSlot('the morning one works', SLOTS)).toBeNull()
  })

  it('returns null when the digit is out of range', () => {
    expect(matchOfferedSlot('9', SLOTS)).toBeNull()
  })

  it('returns null for an empty offered-slots list', () => {
    expect(matchOfferedSlot('1', [])).toBeNull()
  })
})
