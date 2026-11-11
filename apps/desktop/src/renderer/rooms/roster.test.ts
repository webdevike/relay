import { describe, expect, it } from 'vitest'
import { portrait } from '../ui/portrait'

describe('roster', () => {
  it('portraits are deterministic per seed', () => {
    expect(portrait('mara-voss')).toBe(portrait('mara-voss'))
    expect(portrait('mara-voss')).not.toBe(portrait('theo-lindqvist'))
  })
})
