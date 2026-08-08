import { describe, expect, it } from 'vitest'
import { isOptOutMessage, shouldApplyOptOutToWhatsapp } from './opt-out'

describe('isOptOutMessage', () => {
  it('matches the standard STOP-family keywords exactly', () => {
    for (const w of ['stop', 'STOP', ' Stop ', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']) {
      expect(isOptOutMessage(w)).toBe(true)
    }
  })

  it('does not exact-match short keywords when they are part of a longer message', () => {
    // "cancel"/"end" as substrings of unrelated text must NOT trip —
    // that's exactly the false-positive risk the phrase list avoids by
    // staying exact-match-only for the short common words.
    expect(isOptOutMessage('can you cancel my appointment for tomorrow instead')).toBe(false)
    expect(isOptOutMessage('what happens at the end of the term')).toBe(false)
  })

  it('matches the client-document phrase list as a substring anywhere in the message', () => {
    const cases = [
      'please TAKE ME OFF YOUR LIST',
      'Do not contact me again',
      "don't contact me please",
      'do not call this number',
      "don't call me",
      'please do not text',
      "don't text me anymore",
      'do not message me',
      "don't message me",
      'no more messages please',
      'just leave me alone',
      'not interested, thanks',
    ]
    for (const msg of cases) {
      expect(isOptOutMessage(msg)).toBe(true)
    }
  })

  it('is case-insensitive', () => {
    expect(isOptOutMessage('LEAVE ME ALONE')).toBe(true)
    expect(isOptOutMessage('Not Interested')).toBe(true)
  })

  it('returns false for ordinary messages', () => {
    expect(isOptOutMessage('Hi, yes I am interested in a quote')).toBe(false)
    expect(isOptOutMessage('')).toBe(false)
    expect(isOptOutMessage('   ')).toBe(false)
  })
})

describe('shouldApplyOptOutToWhatsapp', () => {
  function dbReturning(data: unknown) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data, error: null }),
          }),
        }),
      }),
    }
  }

  it('defaults to true when there is no ai_configs row', async () => {
    expect(await shouldApplyOptOutToWhatsapp(dbReturning(null), 'acct-1')).toBe(true)
  })

  it('respects an explicit false', async () => {
    expect(
      await shouldApplyOptOutToWhatsapp(dbReturning({ opt_out_applies_to_whatsapp: false }), 'acct-1'),
    ).toBe(false)
  })

  it('respects an explicit true', async () => {
    expect(
      await shouldApplyOptOutToWhatsapp(dbReturning({ opt_out_applies_to_whatsapp: true }), 'acct-1'),
    ).toBe(true)
  })
})
