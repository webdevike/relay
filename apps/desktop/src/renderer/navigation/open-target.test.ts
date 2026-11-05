import { describe, expect, it } from 'vitest'
import { targetOf, type ClickMods, type OpenTarget } from './open-target'

describe('targetOf', () => {
  const table: [string, ClickMods, OpenTarget][] = [
    ['plain', {}, 'here'],
    ['Cmd', { metaKey: true }, 'background'],
    ['Ctrl', { ctrlKey: true }, 'background'],
    ['middle', { button: 1 }, 'background'],
    ['Cmd+Shift', { metaKey: true, shiftKey: true }, 'split'],
    ['Option', { altKey: true }, 'external'],
    ['Shift alone', { shiftKey: true }, 'here'],
    ['Cmd+Option', { metaKey: true, altKey: true }, 'background'],
  ]
  it.each(table)('%s', (_name, mods, want) => {
    expect(targetOf(mods)).toBe(want)
  })
})
