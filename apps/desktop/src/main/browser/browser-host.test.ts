import { beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeView, views } = vi.hoisted(() => {
  let wcSeq = 0
  const views: FakeView[] = []
  type Listener = (...args: unknown[]) => void
  type OpenHandler = (d: { url: string; disposition: string }) => { action: string }

  class FakeWebContents {
    id = ++wcSeq
    destroyed = false
    listeners = new Map<string, Listener[]>()
    openHandler: OpenHandler | null = null
    loadURL = vi.fn(() => Promise.resolve())
    reload = vi.fn()
    stop = vi.fn()
    openDevTools = vi.fn()
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn() }
    isDestroyed = (): boolean => this.destroyed
    close = (): void => {
      this.destroyed = true
    }
    getURL = (): string => ''
    setWindowOpenHandler(h: OpenHandler): void {
      this.openHandler = h
    }
    on(name: string, fn: Listener): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
    }
    fire(name: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(name) ?? []) fn(...args)
    }
  }

  class FakeView {
    webContents = new FakeWebContents()
    visible = true
    constructor() {
      views.push(this)
    }
    setVisible(v: boolean): void {
      this.visible = v
    }
    getVisible(): boolean {
      return this.visible
    }
    setBounds(): void {}
  }
  return { FakeView, views }
})
type FakeView = InstanceType<typeof FakeView>

vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
  dialog: {},
  BaseWindow: class {},
  WebContentsView: FakeView,
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import { setImmediate as nextTick } from 'node:timers/promises'
import type { TabsSnapshot } from '@evaos/contract'
import type { MainContext } from '../context'
import { BrowserHost, LIVE_SCOPES, MAX_TABS } from './browser-host'

const sent: Array<[string, unknown]> = []
const children = new Set<unknown>()

function makeHost(): BrowserHost {
  const ctx = {
    win: {
      isDestroyed: () => false,
      contentView: {
        addChildView: (v: unknown) => children.add(v),
        removeChildView: (v: unknown) => children.delete(v),
      },
    },
    shell: {
      webContents: {
        isDestroyed: () => false,
        send: (ch: string, p: unknown) => sent.push([ch, p]),
        focus: () => {},
      },
    },
    config: { readJson: <T>(_f: string, d: T) => d, writeJson: vi.fn() },
  } as unknown as MainContext
  return new BrowserHost(ctx)
}

const ids = (s: TabsSnapshot): string[] => s.tabs.map((t) => t.id)
const viewOf = (host: BrowserHost, id: string): FakeView | undefined =>
  views.find((v) => v.webContents === (host.tabById(id) as unknown))

let host: BrowserHost
beforeEach(() => {
  views.length = 0
  sent.length = 0
  children.clear()
  host = makeHost()
})

describe('BrowserHost scopes', () => {
  it('starts with no tabs and a scope may stay empty', () => {
    expect(host.snapshot()).toEqual({ tabs: [], activeId: '', scope: '' })
    expect(host.setScope('page:dashboard')).toEqual({
      tabs: [],
      activeId: '',
      scope: 'page:dashboard',
    })
  })

  it('a tab belongs to the scope current at creation; switching swaps the strip', () => {
    host.setScope('chat:/a')
    const a = host.createTab('https://a.test/', true)!
    expect(host.snapshot()).toMatchObject({ activeId: a.id, scope: 'chat:/a' })
    const b = host.setScope('chat:/b')
    expect(b).toMatchObject({ tabs: [], activeId: '', scope: 'chat:/b' })
    const bt = host.createTab(undefined, true)!
    expect(ids(host.snapshot())).toEqual([bt.id])
    const back = host.setScope('chat:/a')
    expect(ids(back)).toEqual([a.id])
    expect(back.activeId).toBe(a.id)
    expect(sent.at(-1)).toEqual(['browser.tabs', back])
  })

  it('restores the remembered active tab, else the newest own tab, else the first pinned', () => {
    host.setScope('A')
    const a1 = host.createTab(undefined, true)!
    const a2 = host.createTab(undefined, true)!
    host.activateTab(a1.id)
    host.setScope('B')
    expect(host.setScope('A').activeId).toBe(a1.id)
    host.closeTab(a1.id)
    host.setScope('B')
    expect(host.setScope('A').activeId).toBe(a2.id)
    host.pinTab(a2.id, true)
    host.setScope('C')
    expect(host.snapshot()).toMatchObject({ activeId: a2.id })
  })

  it('pinned tabs show first in every scope; unpinning moves the tab into the current scope', () => {
    host.setScope('A')
    const a = host.createTab(undefined, true)!
    const p = host.createTab(undefined, true)!
    const snap = host.pinTab(p.id, true)
    expect(ids(snap)).toEqual([p.id, a.id])
    expect(snap.tabs[0]!.pinned).toBe(true)
    expect(ids(host.setScope('B'))).toEqual([p.id])
    const unpinned = host.pinTab(p.id, false)
    expect(unpinned.tabs).toMatchObject([{ id: p.id, pinned: false }])
    expect(ids(host.setScope('A'))).toEqual([a.id])
    expect(ids(host.setScope('B'))).toEqual([p.id])
  })

  it('renameScope carries tabs and the active tab to the new scope', () => {
    host.setScope('draft:3')
    const t = host.createTab('https://x.test/', true)!
    host.renameScope('draft:3', 'chat:/s/n.jsonl')
    expect(host.snapshot()).toMatchObject({ scope: 'chat:/s/n.jsonl', activeId: t.id })
    expect(host.setScope('chat:/s/n.jsonl').tabs.map((x) => x.id)).toEqual([t.id])
    host.setScope('page:dashboard')
    expect(host.setScope('draft:3').tabs).toEqual([])
    expect(host.setScope('chat:/s/n.jsonl').activeId).toBe(t.id)
  })

  it('closing the last tab leaves the scope empty instead of opening a blank tab', () => {
    host.setScope('A')
    const t = host.createTab(undefined, true)!
    expect(host.closeTab(t.id)).toBe('')
    expect(host.snapshot()).toEqual({ tabs: [], activeId: '', scope: 'A' })
  })

  it('only tabs of the current scope can be activated', () => {
    host.setScope('A')
    const a = host.createTab(undefined, true)!
    host.setScope('B')
    const b = host.createTab(undefined, true)!
    expect(host.activateTab(a.id)).toBe(b.id)
  })

  it("window.open from the active tab opens in its opener's scope", async () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const wc = viewOf(host, a.id)!.webContents
    const deny = wc.openHandler!({ url: 'https://b.test/', disposition: 'foreground-tab' })
    expect(deny).toEqual({ action: 'deny' })
    await nextTick()
    const snap = host.snapshot()
    expect(snap.tabs).toHaveLength(2)
    expect(snap.activeId).toBe(snap.tabs[1]!.id)
    expect(snap.tabs[1]!.url).toBe('https://b.test/')
    expect(host.setScope('B').tabs).toEqual([])
  })

  it('a pinned opener opens into the scope in front; background tabs never open tabs', async () => {
    host.setScope('A')
    const p = host.createTab('https://p.test/', true)!
    host.pinTab(p.id, true)
    host.setScope('B')
    const wc = viewOf(host, p.id)!.webContents
    wc.openHandler!({ url: 'https://c.test/', disposition: 'background-tab' })
    await nextTick()
    const snap = host.snapshot()
    expect(snap.tabs.map((t) => t.pinned)).toEqual([true, false])
    expect(snap.activeId).toBe(p.id)
    expect(ids(host.setScope('A'))).toEqual([p.id])
    host.setScope('B')
    const bg = snap.tabs[1]!.id
    const other = viewOf(host, bg)!.webContents
    other.openHandler!({ url: 'https://d.test/', disposition: 'foreground-tab' })
    await nextTick()
    expect(host.snapshot().tabs).toHaveLength(2)
  })
})

describe('BrowserHost memory', () => {
  it('keeps views for pinned tabs and the most recent scopes; older ones go dormant', () => {
    const made: string[] = []
    for (let i = 0; i <= LIVE_SCOPES; i++) {
      host.setScope(`s${i}`)
      made.push(host.createTab(`https://s${i}.test/`, true)!.id)
    }
    host.setScope('s0')
    const pin = host.createTab('https://pin.test/', false)!
    host.pinTab(pin.id, true)
    // s0 revived; the LIVE_SCOPES recent are s0, s5, s4, s3, s2, so s1 went dormant.
    expect(host.tabById(made[1]!)).toBeUndefined()
    expect(host.tabById(made[0]!)).toBeDefined()
    expect(host.tabById(pin.id)).toBeDefined()
    for (let i = 2; i <= LIVE_SCOPES; i++) expect(host.tabById(made[i]!)).toBeDefined()
    for (let i = 6; i < 12; i++) host.setScope(`x${i}`)
    expect(host.tabById(pin.id)).toBeDefined()
    expect(host.views()).toHaveLength(1)
  })

  it('dormant tabs keep their state and revive lazily: the active one at once', () => {
    host.setScope('A')
    const a1 = host.createTab('https://one.test/', true)!
    const a2 = host.createTab('https://two.test/', true)!
    const wc1 = viewOf(host, a1.id)!.webContents
    wc1.fire('did-navigate', {}, 'https://one.test/')
    wc1.fire('page-title-updated', {}, 'One')
    for (let i = 0; i < LIVE_SCOPES; i++) host.setScope(`other${i}`)
    expect(wc1.destroyed).toBe(true)
    expect(host.views()).toHaveLength(0)
    const snap = host.setScope('A')
    expect(snap.activeId).toBe(a2.id)
    expect(snap.tabs.find((t) => t.id === a1.id)).toMatchObject({
      url: 'https://one.test/',
      title: 'One',
    })
    const revived = viewOf(host, a2.id)!
    expect(revived.webContents.loadURL).toHaveBeenCalledWith('https://two.test/')
    expect(host.tabById(a1.id)).toBeUndefined()
    host.activateTab(a1.id)
    expect(viewOf(host, a1.id)!.webContents.loadURL).toHaveBeenCalledWith('https://one.test/')
  })

  it('MAX_TABS counts live views only', () => {
    for (let s = 0; s < 8; s++) {
      host.setScope(`s${s}`)
      for (let i = 0; i < 6; i++) expect(host.createTab(undefined, true)).not.toBeNull()
    }
    expect(host.views().length).toBeLessThanOrEqual(LIVE_SCOPES * 6)
    host.setScope('full')
    while (host.views().length < MAX_TABS) host.createTab(undefined, true)
    expect(host.createTab(undefined, true)).toBeNull()
    expect(sent.at(-1)?.[0]).toBe('browser.notice')
  })
})
