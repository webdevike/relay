import { describe, expect, it } from 'vitest'
import { formatNextDue } from './job-format'

const now = new Date(2026, 9, 15, 12, 0)
const at = (d: number, h: number, m: number): number => new Date(2026, 9, 15 + d, h, m).getTime()

describe('formatNextDue', () => {
  it('handles unscheduled, due now and overdue', () => {
    expect(formatNextDue(null, true, null, now)).toEqual({ text: 'Not scheduled', tone: 'dim' })
    expect(formatNextDue(at(0, 14, 30), false, '2h', now)).toEqual({
      text: 'Not scheduled',
      tone: 'dim',
    })
    expect(formatNextDue(0, true, '2h', now)).toEqual({ text: 'Due now', tone: 'warning' })
    expect(formatNextDue(at(0, 9, 0), true, '2h', now)).toEqual({
      text: 'Overdue',
      tone: 'warning',
    })
  })
  it('formats today, tomorrow and later', () => {
    expect(formatNextDue(at(0, 14, 30), true, '2h', now).text).toBe('Today 2:30 PM')
    expect(formatNextDue(at(1, 8, 30), true, '1d', now).text).toBe('Tomorrow 8:30 AM')
    expect(formatNextDue(at(30, 8, 30), true, '1d', now).text).toBe('Nov 14, 8:30 AM')
  })
})
