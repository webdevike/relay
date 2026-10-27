import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { parseSavedTabs } from './saved-tabs'

const sent: Array<[string, unknown]> = []
const children = new Set<unknown>()

/** A config dir in memory: what one host writes, the next one reads (an app restart). */
function memoryConfig(files = new Map<string, unknown>()) {
  return {
    files,
    readJson: <T>(f: string, d: T): T => (files.has(f) ? (structuredClone(files.get(f)) as T) : d),
    writeJson: vi.fn((f: string, v: unknown) => files.set(f, structuredClone(v))),
  }
}

function makeHost(config = memoryConfig()): BrowserHost {
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
    config,
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

describe('BrowserHost eCard apps per tab', () => {
  const SWITCH = 'https://localhost:3001/reports'
  /** The tab committed a page on the switch, as Chromium reports it. */
  const onSwitch = (id: string): void => {
    const wc = viewOf(host, id)!.webContents
    wc.getURL = () => SWITCH
    wc.fire('did-navigate', {}, SWITCH)
  }

  it('each tab keeps its own app; switching one reloads only that one', () => {
    host.setScope('A')
    const a = host.createTab(SWITCH, true)!
    const b = host.createTab(SWITCH, true, { switchApp: 'assets' })!
    onSwitch(a.id)
    onSwitch(b.id)
    host.setSwitchApp(a.id, 'eng6528')
    expect(host.switchAppOf(a.id)).toBe('eng6528')
    expect(host.switchAppOf(b.id)).toBe('assets')
    expect(viewOf(host, a.id)!.webContents.reload).toHaveBeenCalledTimes(1)
    expect(viewOf(host, b.id)!.webContents.reload).not.toHaveBeenCalled()
    const wcB = viewOf(host, b.id)!.webContents.id
    expect(host.switchAppOfWebContents(wcB)).toBe('assets')
    expect(host.switchAppOfWebContents(-1)).toBeUndefined()
  })

  it('no reload off the switch, for the same app, or when a redirect already carries it', () => {
    host.setScope('A')
    const a = host.createTab('https://other.test/', true)!
    host.setSwitchApp(a.id, 'rbac')
    host.setSwitchApp(a.id, 'rbac')
    onSwitch(a.id)
    host.setSwitchApp(a.id, 'assets', false)
    expect(host.switchAppOf(a.id)).toBe('assets')
    expect(viewOf(host, a.id)!.webContents.reload).not.toHaveBeenCalled()
  })

  it('a switch during the first load starts that load again instead of reloading nothing', () => {
    host.setScope('A')
    const a = host.createTab(SWITCH, true)!
    const wc = viewOf(host, a.id)!.webContents
    host.setSwitchApp(a.id, 'rbac')
    expect(wc.reload).not.toHaveBeenCalled()
    expect(wc.loadURL).toHaveBeenCalledTimes(2)
    expect(wc.loadURL).toHaveBeenLastCalledWith(SWITCH)
  })

  it('a new tab keeps the app of the tab it came from', async () => {
    host.setScope('A')
    const a = host.createTab(SWITCH, true, { switchApp: 'rbac' })!
    const plus = host.createTab(undefined, true)!
    expect(host.switchAppOf(plus.id)).toBe('rbac')
    host.activateTab(a.id)
    viewOf(host, a.id)!.webContents.openHandler!({ url: SWITCH, disposition: 'foreground-tab' })
    await nextTick()
    const opened = host.snapshot().activeId
    expect(opened).not.toBe(a.id)
    expect(host.switchAppOf(opened)).toBe('rbac')
    host.setScope('B')
    expect(host.switchAppOf(host.createTab(SWITCH, true)!.id)).toBeUndefined()
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

describe('BrowserHost restart', () => {
  const files = new Map<string, unknown>()
  beforeEach(() => {
    vi.useFakeTimers()
    files.clear()
  })
  afterEach(() => vi.useRealTimers())

  /** Navigates a tab the way Chromium reports it: did-navigate, then the title. */
  const load = (h: BrowserHost, id: string, url: string, title: string): void => {
    const wc = viewOf(h, id)!.webContents
    wc.fire('did-navigate', {}, url)
    wc.fire('page-title-updated', {}, title)
  }

  it('saves tabs per scope with order, titles, pins and active tab shortly after a change', () => {
    const config = memoryConfig(files)
    const h = makeHost(config)
    h.setScope('chat:/a')
    const a1 = h.createTab('https://a1.test/', true)!
    const a2 = h.createTab('https://a2.test/', true)!
    load(h, a1.id, 'https://a1.test/x', 'A one')
    load(h, a2.id, 'https://a2.test/', 'A two')
    h.activateTab(a1.id)
    h.createTab(undefined, true) // blank: nothing to restore
    h.setScope('page:dashboard')
    const pin = h.createTab('https://pin.test/', true)!
    h.pinTab(pin.id, true)
    const d = h.createTab('https://d.test/', true)!
    expect(config.writeJson).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(files.get('browser-tabs.json')).toEqual({
      tabs: [
        { id: a1.id, scope: 'chat:/a', url: 'https://a1.test/x', title: 'A one', favicon: null },
        { id: a2.id, scope: 'chat:/a', url: 'https://a2.test/', title: 'A two', favicon: null },
        { id: pin.id, scope: '*', url: 'https://pin.test/', title: '', favicon: null },
        { id: d.id, scope: 'page:dashboard', url: 'https://d.test/', title: '', favicon: null },
      ],
      active: { 'chat:/a': expect.any(String), 'page:dashboard': d.id },
    })
  })

  it('a relaunch restores every scope dormant; showing a scope loads only its active tab', () => {
    const first = makeHost(memoryConfig(files))
    first.setScope('chat:/a')
    const a1 = first.createTab('https://a1.test/', true)!
    const a2 = first.createTab('https://a2.test/', true)!
    load(first, a1.id, 'https://a1.test/', 'A one')
    load(first, a2.id, 'https://a2.test/', 'A two')
    first.activateTab(a1.id)
    first.setScope('chat:/b')
    const b1 = first.createTab('https://b1.test/', true)!
    const pin = first.createTab('https://pin.test/', true)!
    first.pinTab(pin.id, true)
    first.dispose()

    views.length = 0
    const next = makeHost(memoryConfig(files))
    expect(next.views()).toHaveLength(0)
    const a = next.setScope('chat:/a')
    expect(a.tabs.map((t) => [t.id, t.url, t.title, t.pinned])).toEqual([
      [pin.id, 'https://pin.test/', '', true],
      [a1.id, 'https://a1.test/', 'A one', false],
      [a2.id, 'https://a2.test/', 'A two', false],
    ])
    expect(a.activeId).toBe(a1.id)
    expect(next.views()).toHaveLength(1)
    expect(viewOf(next, a1.id)!.webContents.loadURL).toHaveBeenCalledWith('https://a1.test/')
    expect(viewOf(next, a1.id)!.visible).toBe(false)
    next.activateTab(a2.id)
    expect(viewOf(next, a2.id)!.webContents.loadURL).toHaveBeenCalledWith('https://a2.test/')
    const b = next.setScope('chat:/b')
    expect(ids(b)).toEqual([pin.id, b1.id])
    expect(b.activeId).toBe(pin.id)
    // New tabs never reuse a restored id.
    const fresh = next.createTab('https://new.test/', true)!
    expect([pin.id, a1.id, a2.id, b1.id]).not.toContain(fresh.id)
  })

  it('a second dispose (window closed, then quit) does not save the emptied host', () => {
    const h = makeHost(memoryConfig(files))
    h.setScope('A')
    h.createTab('https://keep.test/', true)
    h.dispose()
    h.dispose()
    vi.advanceTimersByTime(1000)
    expect(parseSavedTabs(files.get('browser-tabs.json')).tabs).toHaveLength(1)
  })

  it("each tab's eCard app survives a relaunch", () => {
    const first = makeHost(memoryConfig(files))
    first.setScope('chat:/a')
    const a = first.createTab('https://localhost:3001/', true, { switchApp: 'rbac' })!
    const b = first.createTab('https://localhost:3001/', true, { switchApp: 'assets' })!
    const c = first.createTab('https://c.test/', true)!
    first.setSwitchApp(c.id, 'eng6528')
    first.dispose()
    expect(parseSavedTabs(files.get('browser-tabs.json')).tabs.map((t) => t.switchApp)).toEqual([
      'rbac',
      'assets',
      'eng6528',
    ])
    const next = makeHost(memoryConfig(files))
    expect([a.id, b.id, c.id].map((id) => next.switchAppOf(id))).toEqual([
      'rbac',
      'assets',
      'eng6528',
    ])
  })
})
