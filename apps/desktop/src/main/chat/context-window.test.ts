import { describe, expect, it } from 'vitest'
import { windowFromShare } from './context-window'

describe('windowFromShare', () => {
  it('snaps a derived window to a common one', () => {
    expect(windowFromShare(130_109, 0.65)).toBe(200_000)
    expect(windowFromShare(500_000, 0.5)).toBe(1_000_000)
  })

  it('rounds to thousands when nothing common is near', () => {
    expect(windowFromShare(150_000, 0.3)).toBe(500_000)
    expect(windowFromShare(33_000, 0.2)).toBe(165_000)
  })

  it('is null without tokens or a usable share', () => {
    expect(windowFromShare(null, 0.5)).toBeNull()
    expect(windowFromShare(0, 0.5)).toBeNull()
    expect(windowFromShare(1000, null)).toBeNull()
    expect(windowFromShare(1000, undefined)).toBeNull()
    expect(windowFromShare(1000, 0.01)).toBeNull()
  })
})
