import { describe, expect, it } from 'vitest'
import { MAX_SAVED_TABS, parseSavedTabs } from './saved-tabs'

const tab = (id: string, url = `https://${id}.test/`, scope = 'chat:/a') => ({
  id,
  scope,
  url,
  title: id,
  favicon: null,
})

describe('parseSavedTabs', () => {
  it('missing or malformed files restore nothing', () => {
    for (const raw of [null, [], 'x', { tabs: 'no' }, {}]) {
      expect(parseSavedTabs(raw)).toEqual({ tabs: [], active: {} })
    }
  })

  it('keeps valid tabs in order and drops bad ids, duplicates, scopes and unloadable URLs', () => {
    const raw = {
      tabs: [
        tab('t1'),
        { ...tab('t2'), id: 'x2' },
        tab('t1', 'https://dup.test/'),
        tab('t3', 'javascript:alert(1)'),
        tab('t4', 'file:///etc/passwd'),
        { ...tab('t5'), scope: '' },
        tab('t6', 'chrome-extension://abc/popup.html'),
        { ...tab('t7', 'chrome-extension://abc/popup.html'), fromExtension: true },
        { id: 't8', scope: '*', url: 'https://pin.test/', title: 3, favicon: 4 },
      ],
      active: { 'chat:/a': 't7', 'chat:/b': 't3', 'chat:/c': 9 },
    }
    expect(parseSavedTabs(raw)).toEqual({
      tabs: [
        tab('t1'),
        { ...tab('t7', 'chrome-extension://abc/popup.html'), fromExtension: true },
        { id: 't8', scope: '*', url: 'https://pin.test/', title: '', favicon: null },
      ],
      active: { 'chat:/a': 't7' },
    })
  })

  it("keeps a tab's eCard app and drops a malformed one without dropping the tab", () => {
    const raw = {
      tabs: [
        { ...tab('t1'), switchApp: 'rbac' },
        { ...tab('t2'), switchApp: '../x' },
        { ...tab('t3'), switchApp: 7 },
        { ...tab('t4'), switchApp: '' },
      ],
      active: {},
    }
    expect(parseSavedTabs(raw).tabs).toEqual([
      { ...tab('t1'), switchApp: 'rbac' },
      tab('t2'),
      tab('t3'),
      tab('t4'),
    ])
  })

  it('keeps who opened a tab and drops a malformed label without dropping the tab', () => {
    const raw = {
      tabs: [
        { ...tab('t1'), openedBy: 'Nova' },
        { ...tab('t2'), openedBy: 'x'.repeat(121) },
        { ...tab('t3'), openedBy: 5 },
      ],
      active: {},
    }
    expect(parseSavedTabs(raw).tabs).toEqual([
      { ...tab('t1'), openedBy: 'Nova' },
      tab('t2'),
      tab('t3'),
    ])
  })

  it('keeps the newest MAX_SAVED_TABS', () => {
    const tabs = Array.from({ length: MAX_SAVED_TABS + 5 }, (_, i) => tab(`t${i + 1}`))
    const out = parseSavedTabs({ tabs, active: { 'chat:/a': 't1' } })
    expect(out.tabs).toHaveLength(MAX_SAVED_TABS)
    expect(out.tabs[0]!.id).toBe('t6')
    expect(out.active).toEqual({})
  })
})
