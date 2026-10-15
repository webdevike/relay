import { describe, expect, it } from 'vitest'
import { mergeLayout, readLayoutText, serializeLayout } from './layout-file'

const defaults = { sidebarWidth: 272, panelWidth: 420, tabs: null, malformed: false }

describe('readLayoutText', () => {
  it('missing file gives defaults silently', () => {
    expect(readLayoutText(null)).toEqual(defaults)
  })
  it('clamps widths', () => {
    const r = readLayoutText('{"sidebar_width": 999, "panel_width": 10}')
    expect(r.sidebarWidth).toBe(420)
    expect(r.panelWidth).toBe(320)
  })
  it('flags malformed text and non-objects', () => {
    expect(readLayoutText('not json')).toEqual({ ...defaults, malformed: true })
    expect(readLayoutText('[]')).toEqual({ ...defaults, malformed: true })
    expect(readLayoutText('null')).toEqual({ ...defaults, malformed: true })
  })
  it('non-numeric widths fall back to defaults', () => {
    expect(readLayoutText('{"sidebar_width":"wide"}')).toEqual(defaults)
  })
  it('returns raw tabs', () => {
    expect(readLayoutText('{"tabs":{"a":1}}').tabs).toEqual({ a: 1 })
  })
})

describe('mergeLayout', () => {
  it('preserves unknown keys and rounds widths', () => {
    expect(mergeLayout({ foo: 1, sidebar_width: 300 }, { panelWidth: 433.6 })).toEqual({
      foo: 1,
      sidebar_width: 300,
      panel_width: 434,
    })
  })
  it('clamps', () => {
    expect(mergeLayout({}, { sidebarWidth: 1000 })).toEqual({ sidebar_width: 420 })
  })
  it('handles non-object existing and tabs', () => {
    expect(mergeLayout('x', { tabs: [1] })).toEqual({ tabs: [1] })
    expect(mergeLayout([], { tabs: null })).toEqual({ tabs: null })
  })
  it('serializes pretty with trailing newline', () => {
    expect(serializeLayout({ a: 1 })).toBe('{\n  "a": 1\n}\n')
  })
})
