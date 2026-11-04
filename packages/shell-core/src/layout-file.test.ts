import { describe, expect, it } from 'vitest'
import { mergeLayout, readLayoutText, serializeLayout } from './layout-file'

const defaults = {
  sidebarWidth: 272,
  tabs: null,
  dock: null,
  tiling: null,
  legacyPanel: { width: 420, tool: 'browser' },
  sidebar: null,
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
    expect(readLayoutText('{"panel_tool":"nope"}').legacyPanel).toEqual(defaults.legacyPanel)
  })
  it('a saved split tree wins over the old panel, a dockview layout over both', () => {
    const tiling = { version: 1, root: { type: 'pane', id: 'chat', tabs: [], active: null } }
    const r = readLayoutText(JSON.stringify({ panel_width: 500, tiling }))
    expect(r.tiling).toEqual(tiling)
    expect(r.dock).toBeNull()
    expect(r.legacyPanel).toBeNull()
    const dock = { grid: { root: { type: 'branch', data: [] } }, panels: {} }
    const both = readLayoutText(JSON.stringify({ panel_width: 500, tiling, dock }))
    expect(both).toMatchObject({ dock, tiling: null, legacyPanel: null })
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
  it('the dockview layout replaces the split tree and the old panel keys, other keys stay', () => {
    const dock = { grid: {}, panels: {} }
    const out = mergeLayout(
      {
        zoom: 2,
        tiling: { root: {} },
        panel_width: 400,
        panel_choices: { a: true },
        panel_tool: 'files',
      },
      { dock },
    )
    expect(out).toEqual({ zoom: 2, dock })
    expect(mergeLayout({}, {})).toEqual({})
  })
})

describe('sidebar customization', () => {
  it('reads the saved object and ignores anything else', () => {
    const sidebar = { badgeStyle: 'dot', visibility: { jobs: 'never' } }
    expect(readLayoutText(JSON.stringify({ sidebar })).sidebar).toEqual(sidebar)
    expect(readLayoutText('{"sidebar": [1]}').sidebar).toBeNull()
    expect(readLayoutText('{"sidebar": "x"}').sidebar).toBeNull()
  })
  it('replaces it whole and keeps every other key', () => {
    const next = mergeLayout(
      { sidebar_width: 300, sidebar: { a: 1 }, dock: { x: 1 } },
      { sidebar: { b: 2 } },
    )
    expect(next).toEqual({ sidebar_width: 300, sidebar: { b: 2 }, dock: { x: 1 } })
    expect(mergeLayout({ sidebar: { a: 1 } }, { sidebarWidth: 280 })['sidebar']).toEqual({ a: 1 })
  })
})
