import { describe, expect, it } from 'vitest'
import { mergeLayout, readLayoutText, serializeLayout } from './layout-file'

const defaults = {
  sidebarWidth: 272,
  panelWidth: 420,
  tabs: null,
  panelChoices: {},
  panelTool: 'browser',
  malformed: false,
}

const scopes = (n: number, from = 0) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${from + i}`, true]))

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
  it('reads panel choices and tool, dropping invalid values', () => {
    const r = readLayoutText(
      '{"panel_choices":{"a":true,"b":"yes","c":false,"d":null},"panel_tool":"files"}',
    )
    expect(r.panelChoices).toEqual({ a: true, c: false })
    expect(r.panelTool).toBe('files')
    expect(readLayoutText('{"panel_choices":[true],"panel_tool":"terminal"}')).toEqual(defaults)
    expect(readLayoutText('{"panel_tool":"artifacts"}').panelTool).toBe('artifacts')
  })
  it('keeps the most recent 200 stored choices', () => {
    const r = readLayoutText(JSON.stringify({ panel_choices: scopes(205) }))
    expect(Object.keys(r.panelChoices)).toEqual(Object.keys(scopes(200, 5)))
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
  it('upserts panel choices to the recent end, forgets nulls, keeps other keys', () => {
    const out = mergeLayout(
      { zoom: 2, panel_choices: { a: true, b: false, c: true } },
      { panelChoices: { a: false, c: null, d: true } },
    )
    expect(out).toEqual({ zoom: 2, panel_choices: { b: false, a: false, d: true } })
    expect(Object.keys(out['panel_choices'] as object)).toEqual(['b', 'a', 'd'])
  })
  it('caps merged choices to the most recent 200', () => {
    const out = mergeLayout(
      { panel_choices: scopes(200) },
      { panelChoices: { s0: false, x: true } },
    )
    const keys = Object.keys(out['panel_choices'] as object)
    expect(keys).toHaveLength(200)
    expect(keys.slice(0, 2)).toEqual(['s2', 's3'])
    expect(keys.slice(-2)).toEqual(['s0', 'x'])
  })
  it('sets a valid panel tool only', () => {
    expect(mergeLayout({ panel_tool: 'files' }, { panelTool: 'browser' })).toEqual({
      panel_tool: 'browser',
    })
    expect(mergeLayout({}, {})).toEqual({})
  })
})
