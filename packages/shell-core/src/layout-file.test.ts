import { describe, expect, it } from 'vitest'
import { mergeLayout, readLayoutText, serializeLayout } from './layout-file'
import { defaultTiling, tilingToJson } from './tiling'

const defaults = {
  sidebarWidth: 272,
  tabs: null,
  tiling: null,
  legacyPanel: { width: 420, tool: 'browser' },
  malformed: false,
}

describe('readLayoutText', () => {
  it('missing file gives defaults silently, with nothing to migrate', () => {
    expect(readLayoutText(null)).toEqual({ ...defaults, legacyPanel: null })
  })
  it('clamps the sidebar width', () => {
    expect(readLayoutText('{"sidebar_width": 999}').sidebarWidth).toBe(420)
  })
  it('flags malformed text and non-objects', () => {
    const bad = { ...defaults, legacyPanel: null, malformed: true }
    expect(readLayoutText('not json')).toEqual(bad)
    expect(readLayoutText('[]')).toEqual(bad)
    expect(readLayoutText('null')).toEqual(bad)
  })
  it('non-numeric widths fall back to defaults', () => {
    expect(readLayoutText('{"sidebar_width":"wide"}')).toEqual(defaults)
  })
  it('returns raw tabs', () => {
    expect(readLayoutText('{"tabs":{"a":1}}').tabs).toEqual({ a: 1 })
  })
  it('reads the old panel width and tool for the migration', () => {
    const r = readLayoutText('{"panel_width":500,"panel_tool":"files","panel_choices":{"a":true}}')
    expect(r.legacyPanel).toEqual({ width: 500, tool: 'files' })
    expect(readLayoutText('{"panel_tool":"terminal"}').legacyPanel).toEqual(defaults.legacyPanel)
  })
  it('a saved tiling wins over the old panel', () => {
    const tiling = defaultTiling(0.4, 'files')
    const r = readLayoutText(JSON.stringify({ panel_width: 500, tiling: tilingToJson(tiling) }))
    expect(r.tiling).toEqual(tiling)
    expect(r.legacyPanel).toBeNull()
  })
})

describe('mergeLayout', () => {
  it('preserves unknown keys and rounds widths', () => {
    expect(mergeLayout({ foo: 1, sidebar_width: 300 }, { sidebarWidth: 280.6 })).toEqual({
      foo: 1,
      sidebar_width: 281,
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
  it('a tiling replaces the panel choices and tool, other keys stay', () => {
    const tiling = defaultTiling()
    const out = mergeLayout(
      { zoom: 2, panel_width: 400, panel_choices: { a: true }, panel_tool: 'files' },
      { tiling },
    )
    expect(out).toEqual({ zoom: 2, panel_width: 400, tiling: tilingToJson(tiling) })
    expect(mergeLayout({}, {})).toEqual({})
  })
})
