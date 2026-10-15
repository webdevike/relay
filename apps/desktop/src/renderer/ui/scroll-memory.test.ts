import { beforeEach, describe, expect, it } from 'vitest'
import { getScroll, resetScrollMemory, setScroll } from './scroll-memory'

describe('scroll memory', () => {
  beforeEach(resetScrollMemory)

  it('stores per key and returns 0 for unknown keys', () => {
    setScroll('page:tasks', 120)
    expect(getScroll('page:tasks')).toBe(120)
    expect(getScroll('page:other')).toBe(0)
  })

  it('is bounded to 200 keys, dropping the oldest', () => {
    for (let i = 0; i < 205; i++) setScroll(`k${i}`, i + 1)
    expect(getScroll('k0')).toBe(0)
    expect(getScroll('k4')).toBe(0)
    expect(getScroll('k5')).toBe(6)
    expect(getScroll('k204')).toBe(205)
  })
})
