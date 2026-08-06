import { describe, expect, it } from 'vitest'
import { columnLetterToIndex, extractSheetName } from './sheets-sync'

describe('columnLetterToIndex', () => {
  it('converts single letters', () => {
    expect(columnLetterToIndex('A')).toBe(0)
    expect(columnLetterToIndex('B')).toBe(1)
    expect(columnLetterToIndex('F')).toBe(5)
    expect(columnLetterToIndex('Z')).toBe(25)
  })

  it('converts double letters', () => {
    expect(columnLetterToIndex('AA')).toBe(26)
    expect(columnLetterToIndex('AB')).toBe(27)
  })

  it('is case-insensitive', () => {
    expect(columnLetterToIndex('a')).toBe(0)
    expect(columnLetterToIndex('f')).toBe(5)
  })
})

describe('extractSheetName', () => {
  it('extracts the sheet name before the !', () => {
    expect(extractSheetName('Sheet1!A:E')).toBe('Sheet1')
    expect(extractSheetName('Leads!A1:F100')).toBe('Leads')
  })

  it('returns the whole string when there is no !', () => {
    expect(extractSheetName('Sheet1')).toBe('Sheet1')
  })
})
