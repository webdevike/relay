import { describe, expect, it } from 'vitest'
import { clockLabel, elapsedLabel } from './format'

describe('context time labels', () => {
  it('says how long something has run', () => {
    const now = Date.UTC(2026, 9, 27, 20, 0)
    expect(elapsedLabel(now - 20_000, now)).toBe('now')
    expect(elapsedLabel(now - 6 * 60_000, now)).toBe('6m')
    expect(elapsedLabel(now - 125 * 60_000, now)).toBe('2h 5m')
    expect(elapsedLabel(now - 120 * 60_000, now)).toBe('2h')
    expect(elapsedLabel(now - 3 * 86_400_000, now)).toBe('3d')
  })

  it('shows a clock time today and a date before', () => {
    const now = new Date(2026, 9, 27, 18, 0).getTime()
    expect(clockLabel(new Date(2026, 9, 27, 16, 29).getTime(), now)).toBe('4:29 PM')
    expect(clockLabel(new Date(2026, 9, 26, 16, 29).getTime(), now)).toBe('Oct 26')
  })
})
