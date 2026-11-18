import { describe, expect, it } from 'vitest'
import {
  FORWARD_FROM_GUEST,
  actionFor,
  chordOf,
  chordOfInput,
  isMod,
  isNativeEditChord,
  keyLabel,
  platformChord,
  terminalAliases,
  terminalPassThrough,
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
    expect(FORWARD_FROM_GUEST.has('cmd+[')).toBe(true)
    expect(FORWARD_FROM_GUEST.has('escape')).toBe(false)
  })
  it('leaves cmd+left and cmd+right to a web page, and maps them to history elsewhere', () => {
    expect(FORWARD_FROM_GUEST.has('cmd+arrowleft')).toBe(false)
    expect(FORWARD_FROM_GUEST.has('cmd+arrowright')).toBe(false)
    expect(actionFor('cmd+arrowleft')).toBe('history-back')
    expect(actionFor('cmd+arrowright')).toBe('history-forward')
    expect(actionFor('cmd+[')).toBe('history-back')
  })
  it('flags native edit chords', () => {
    for (const c of ['cmd+c', 'cmd+v', 'cmd+x', 'cmd+a', 'cmd+z', 'cmd+shift+z']) {
      expect(isNativeEditChord(c)).toBe(true)
    }
    expect(isNativeEditChord('cmd+b')).toBe(false)
  })
})

describe('platforms', () => {
  it('macOS: Cmd is the app modifier and Ctrl stays ctrl', () => {
    expect(chordOf({ key: 't', code: 'KeyT', metaKey: true }, true)).toBe('cmd+t')
    expect(chordOf({ key: 't', code: 'KeyT', ctrlKey: true }, true)).toBe('ctrl+t')
    expect(chordOf({ key: '`', code: 'Backquote', ctrlKey: true }, true)).toBe('ctrl+`')
    expect(chordOfInput({ type: 'keyDown', key: 'w', code: 'KeyW', control: true }, true)).toBe(
      'ctrl+w',
    )
    expect(isMod({ metaKey: true }, true)).toBe(true)
    expect(isMod({ ctrlKey: true }, true)).toBe(false)
    expect(platformChord('ctrl+`', true)).toBe('ctrl+`')
    expect(keyLabel('Explorer (⌘⇧E)', true)).toBe('Explorer (⌘⇧E)')
    expect(terminalPassThrough(true)).toEqual(['cmd+shift+b', 'cmd+b', 'cmd+t', 'cmd+w', 'cmd+q'])
    expect(terminalAliases(true)).toEqual({})
  })

  it('Linux: Ctrl is the app modifier (Super still counts)', () => {
    expect(chordOf({ key: 't', code: 'KeyT', ctrlKey: true }, false)).toBe('cmd+t')
    expect(chordOf({ key: 't', code: 'KeyT', metaKey: true }, false)).toBe('cmd+t')
    expect(chordOf({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }, false)).toBe(
      'cmd+shift+c',
    )
    expect(chordOf({ key: 'c', code: 'KeyC', ctrlKey: true }, false)).toBe('cmd+c')
    expect(isNativeEditChord(chordOf({ key: 'a', code: 'KeyA', ctrlKey: true }, false)!)).toBe(true)
    expect(chordOfInput({ type: 'keyDown', key: 'w', code: 'KeyW', control: true }, false)).toBe(
      'cmd+w',
    )
    expect(isMod({ ctrlKey: true }, false)).toBe(true)
    expect(isMod({ altKey: true } as { ctrlKey?: boolean }, false)).toBe(false)
    expect(platformChord('ctrl+`', false)).toBe('cmd+`')
    expect(platformChord('cmd+shift+f', false)).toBe('cmd+shift+f')
  })

  it('Linux: a focused terminal keeps Ctrl keys and takes Ctrl+Shift for tabs', () => {
    const pass = terminalPassThrough(false)
    for (const c of ['cmd+b', 'cmd+t', 'cmd+w', 'cmd+q', 'cmd+c']) expect(pass).not.toContain(c)
    expect(pass).toContain('cmd+shift+b')
    expect(terminalAliases(false)).toEqual({ 'cmd+shift+t': 'cmd+t', 'cmd+shift+w': 'cmd+w' })
  })

  it('Linux: shortcut labels say Ctrl, Alt, Shift and Enter', () => {
    expect(keyLabel('⌘⇧F', false)).toBe('Ctrl+Shift+F')
    expect(keyLabel('⌥⌘↩', false)).toBe('Ctrl+Alt+Enter')
    expect(keyLabel('⇧⌘\\', false)).toBe('Ctrl+Shift+\\')
    expect(keyLabel('⌘ 1', false)).toBe('Ctrl+1')
    expect(keyLabel('Explorer (⌘⇧E)', false)).toBe('Explorer (Ctrl+Shift+E)')
    expect(keyLabel('Stop (press Esc twice, or ⌘.)', false)).toBe(
      'Stop (press Esc twice, or Ctrl+.)',
    )
    expect(keyLabel('press ⌘P to find one', false)).toBe('press Ctrl+P to find one')
  })
})
