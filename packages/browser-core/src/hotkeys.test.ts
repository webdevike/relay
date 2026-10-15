import { describe, expect, it } from 'vitest'
import { matchesAppChord } from './hotkeys'

describe('matchesAppChord', () => {
  it('matches the chord table', () => {
    expect(matchesAppChord({ type: 'keyDown', key: 't', meta: true })).toBe('new-tab')
    expect(matchesAppChord({ type: 'keyDown', key: 'T', meta: true })).toBe('new-tab')
    expect(matchesAppChord({ type: 'keyDown', key: 'b', meta: true, shift: true })).toBe(
      'toggle-panel',
    )
    expect(matchesAppChord({ type: 'keyDown', key: 'i', meta: true, alt: true })).toBe('devtools')
    expect(matchesAppChord({ type: 'keyDown', key: '[', meta: true })).toBe('prev-tab')
  })
  it('rejects non chords', () => {
    expect(matchesAppChord({ type: 'keyDown', key: 't' })).toBeNull()
    expect(matchesAppChord({ type: 'keyUp', key: 't', meta: true })).toBeNull()
    expect(matchesAppChord({ type: 'keyDown', key: 'b', meta: true })).toBeNull()
    expect(matchesAppChord({ type: 'keyDown', key: 't', meta: true, shift: true })).toBeNull()
    expect(
      matchesAppChord({ type: 'keyDown', key: 'w', meta: true, isAutoRepeat: true }),
    ).toBeNull()
  })
})
