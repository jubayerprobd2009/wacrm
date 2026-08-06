import { describe, expect, it } from 'vitest'
import {
  parseQualificationReply,
  EMPTY_QUALIFICATION_DATA,
  type QualificationData,
} from './qualification-assistant'

describe('parseQualificationReply', () => {
  it('strips the sentinel block and returns the customer-facing text', () => {
    const raw =
      'Great, what date works for you?\n[[LEAD_DATA]]{"full_name":"Jane Doe","reason":null,"insurance_type":"auto","preferred_date":null,"preferred_time":null,"phone":null,"email":null}'
    const { text, data, ready } = parseQualificationReply(raw, EMPTY_QUALIFICATION_DATA)
    expect(text).toBe('Great, what date works for you?')
    expect(data.full_name).toBe('Jane Doe')
    expect(data.insurance_type).toBe('auto')
    expect(ready).toBe(false)
  })

  it('merges new fields onto known data rather than dropping them', () => {
    const known: QualificationData = {
      ...EMPTY_QUALIFICATION_DATA,
      full_name: 'Jane Doe',
      phone: '+15551234567',
    }
    const raw = 'Got it.\n[[LEAD_DATA]]{"full_name":null,"reason":"car insurance","insurance_type":null,"preferred_date":null,"preferred_time":null,"phone":null,"email":null}'
    const { data } = parseQualificationReply(raw, known)
    expect(data.full_name).toBe('Jane Doe') // preserved, model returned null
    expect(data.phone).toBe('+15551234567') // preserved
    expect(data.reason).toBe('car insurance') // new
  })

  it('marks ready only when the sentinel is present AND all fields are filled', () => {
    const complete: QualificationData = {
      full_name: 'Jane Doe',
      reason: 'car insurance quote',
      insurance_type: 'auto',
      preferred_date: '2026-08-10',
      preferred_time: '2pm',
      phone: '+15551234567',
      email: 'jane@example.com',
    }
    const raw = `Perfect, see you then!\n[[LEAD_READY]]\n[[LEAD_DATA]]${JSON.stringify(complete)}`
    const { ready, text } = parseQualificationReply(raw, EMPTY_QUALIFICATION_DATA)
    expect(ready).toBe(true)
    expect(text).toBe('Perfect, see you then!')
  })

  it('does not mark ready if the sentinel is present but fields are incomplete', () => {
    const raw = '[[LEAD_READY]]\n[[LEAD_DATA]]{"full_name":"Jane","reason":null,"insurance_type":null,"preferred_date":null,"preferred_time":null,"phone":null,"email":null}'
    const { ready } = parseQualificationReply(raw, EMPTY_QUALIFICATION_DATA)
    expect(ready).toBe(false)
  })

  it('keeps prior known data and still returns the text when JSON is malformed', () => {
    const known: QualificationData = { ...EMPTY_QUALIFICATION_DATA, full_name: 'Jane Doe' }
    const raw = 'What is your email?\n[[LEAD_DATA]]{not valid json'
    const { text, data, ready } = parseQualificationReply(raw, known)
    expect(text).toBe('What is your email?')
    expect(data.full_name).toBe('Jane Doe')
    expect(ready).toBe(false)
  })

  it('handles a reply with no sentinel at all (model ignored the instruction)', () => {
    const known: QualificationData = { ...EMPTY_QUALIFICATION_DATA, full_name: 'Jane Doe' }
    const raw = 'Sure thing!'
    const { text, data } = parseQualificationReply(raw, known)
    expect(text).toBe('Sure thing!')
    expect(data).toEqual(known)
  })
})
