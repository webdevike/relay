import { describe, expect, it } from 'vitest'
import {
  FORWARD_FROM_GUEST,
  GLOBAL_CHORDS,
  actionFor,
  chordOf,
  chordOfInput,
  isNativeEditChord,
} from './chord'

describe('chordOf', () => {
  it('normalises modifiers and keys', () => {
    expect(chordOf({ key: 'b', code: 'KeyB', metaKey: true, shiftKey: true })).toBe('cmd+shift+b')
    expect(chordOf({ key: '{', code: 'BracketLeft', metaKey: true })).toBe('cmd+[')
    expect(chordOf({ key: '}', code: 'BracketRight', metaKey: true })).toBe('cmd+]')
    expect(chordOf({ key: '!', code: 'Digit1', metaKey: true, shiftKey: true })).toBe('cmd+shift+1')
    expect(chordOf({ key: '3', code: 'Digit3', metaKey: true })).toBe('cmd+3')
    expect(chordOf({ key: 'Escape', code: 'Escape' })).toBe('escape')
    expect(chordOf({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })).toBe('cmd+shift+c')
  })
  it('ignores bare modifiers and composition', () => {
    for (const key of ['Meta', 'Shift', 'Control', 'Alt']) {
      expect(chordOf({ key, code: key, metaKey: true })).toBeNull()
    }
    expect(chordOf({ key: 'a', code: 'KeyA', isComposing: true })).toBeNull()
  })
})

describe('chordOfInput', () => {
  it('handles keyDown only', () => {
    expect(chordOfInput({ type: 'keyDown', key: 'w', code: 'KeyW', meta: true })).toBe('cmd+w')
    expect(chordOfInput({ type: 'keyUp', key: 'w', code: 'KeyW', meta: true })).toBeNull()
    expect(
      chordOfInput({ type: 'keyDown', key: 'w', code: 'KeyW', meta: true, isAutoRepeat: true }),
    ).toBeNull()
    expect(chordOfInput({ type: 'keyDown', key: 'L', meta: true })).toBe('cmd+l')
  })
})

describe('chord table', () => {
  it('maps actions', () => {
    expect(actionFor('cmd+shift+b')).toBe('toggle-panel')
    expect(actionFor('escape')).toBe('dismiss')
    expect(actionFor('cmd+c')).toBeNull()
  })
  it('forwards from guests', () => {
    expect(FORWARD_FROM_GUEST.has('cmd+l')).toBe(true)
    expect(FORWARD_FROM_GUEST.has('escape')).toBe(false)
    expect(FORWARD_FROM_GUEST.size).toBe(GLOBAL_CHORDS.length)
  })
  it('flags native edit chords', () => {
    for (const c of ['cmd+c', 'cmd+v', 'cmd+x', 'cmd+a', 'cmd+z', 'cmd+shift+z']) {
      expect(isNativeEditChord(c)).toBe(true)
    }
    expect(isNativeEditChord('cmd+b')).toBe(false)
  })
})
