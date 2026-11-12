import { describe, expect, it } from 'vitest'
import { swipeChord } from './swipe'

describe('swipeChord', () => {
  it('maps a left swipe to Back and a right swipe to Forward', () => {
    expect(swipeChord('left')).toBe('cmd+[')
    expect(swipeChord('right')).toBe('cmd+]')
  })

  it('ignores vertical swipes', () => {
    expect(swipeChord('up')).toBeNull()
    expect(swipeChord('down')).toBeNull()
  })
})
