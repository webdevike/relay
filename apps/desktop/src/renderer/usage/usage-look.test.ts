import { describe, expect, it } from 'vitest'
import type { UsageAccount, UsageWindow } from '@evaos/contract'
import { agoLabel, mostUsed, resetLabel, usageLevel, windowLevel, windowReset } from './usage-look'

const win = (id: string, usedFraction: number, status = 'ok'): UsageWindow => ({
  id,
  label: id,
  usedFraction,
  resetsAt: null,
  status,
})
const account = (windows: UsageWindow[]): UsageAccount => ({
  key: 'work:anthropic',
  profile: 'work',
  profileLabel: 'Work',
  provider: 'anthropic',
  email: null,
  windows,
  fetchedAt: 1,
  stale: false,
  error: null,
})

describe('mostUsed', () => {
  it('picks the window closest to its limit, the first on a tie', () => {
    expect(mostUsed([win('5h', 0.2), win('7d', 0.65), win('fable', 0.31)])!.id).toBe('7d')
    expect(mostUsed([win('a', 0.5), win('b', 0.5)])!.id).toBe('a')
    expect(mostUsed([])).toBeNull()
  })
})

describe('levels', () => {
  it('is dim below 70%, yellow from 70% to 89%, red from 90%', () => {
    expect(usageLevel(account([win('a', 0.694)]))).toBe('normal')
    expect(usageLevel(account([win('a', 0.7)]))).toBe('warn')
    expect(usageLevel(account([win('a', 0.89)]))).toBe('warn')
    expect(usageLevel(account([win('a', 0.696)]))).toBe('warn')
    expect(usageLevel(account([win('a', 0.9)]))).toBe('danger')
    expect(usageLevel(account([win('a', 1.2)]))).toBe('danger')
  })

  it('is red when any window is limited, and none without data', () => {
    expect(usageLevel(account([win('a', 0.9), win('b', 0.1, 'limited')]))).toBe('danger')
    expect(windowLevel(win('b', 0.1, 'exhausted'))).toBe('danger')
    expect(usageLevel(account([]))).toBe('none')
  })
})

describe('time labels', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0)
  it('counts down under a day, then names the day and time', () => {
    expect(resetLabel(null, now)).toBe('no reset time')
    expect(resetLabel(now - 1, now)).toBe('resets now')
    expect(resetLabel(now + 30_000, now)).toBe('resets in 1m')
    expect(resetLabel(now + 42 * 60_000, now)).toBe('resets in 42m')
    expect(resetLabel(now + (3 * 60 + 5) * 60_000, now)).toBe('resets in 3h 5m')
    const later = now + 3 * 86_400_000
    const expected = new Date(later)
      .toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      .replace(',', '')
    expect(resetLabel(later, now)).toBe(`resets ${expected}`)
    expect(windowReset({ ...win('a', 1, 'limited'), resetsAt: now + 60_000 }, now)).toBe(
      'limited, resets in 1m',
    )
  })

  it('says how long ago', () => {
    expect(agoLabel(now - 10_000, now)).toBe('just now')
    expect(agoLabel(now - 4 * 60_000, now)).toBe('4 min ago')
    expect(agoLabel(now - 2 * 3_600_000, now)).toBe('2 h ago')
    expect(agoLabel(now - 86_400_000, now)).toBe('1 day ago')
    expect(agoLabel(now + 5000, now)).toBe('just now')
  })
})
