import { IconCircle, IconListCheck, IconPhoto } from '@tabler/icons-react'
import { describe, expect, it } from 'vitest'
import { STEP_ICONS, stepIcon } from './step-icons'

describe('stepIcon', () => {
  it('resolves kebab-case names', () => {
    expect(stepIcon('photo')).toBe(IconPhoto)
    expect(stepIcon('list-check')).toBe(IconListCheck)
  })

  it('accepts component and spaced spellings', () => {
    expect(stepIcon('IconListCheck')).toBe(IconListCheck)
    expect(stepIcon(' List Check ')).toBe(IconListCheck)
  })

  it('falls back to a circle for unknown or missing names', () => {
    expect(stepIcon('no-such-icon')).toBe(IconCircle)
    expect(stepIcon(undefined)).toBe(IconCircle)
    expect(stepIcon('')).toBe(IconCircle)
  })

  it('names every icon the brief lists', () => {
    for (const n of ['rocket', 'shield-check', 'hand-stop', 'adjustments', 'sparkles', 'refresh'])
      expect(STEP_ICONS[n]).toBeDefined()
    expect(Object.keys(STEP_ICONS).length).toBeGreaterThanOrEqual(90)
  })
})
