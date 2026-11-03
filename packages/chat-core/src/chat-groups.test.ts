import { describe, expect, it } from 'vitest'
import { isRecentlyActive, RECENTLY_ACTIVE_MS } from './chat-groups'

describe('isRecentlyActive', () => {
  it('uses a ten minute window', () => {
    const now = 10_000_000
    expect(RECENTLY_ACTIVE_MS).toBe(600_000)
    expect(isRecentlyActive(now - 599_999, now)).toBe(true)
    expect(isRecentlyActive(now - 600_001, now)).toBe(false)
  })
})
