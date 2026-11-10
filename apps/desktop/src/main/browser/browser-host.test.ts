import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { FakeView, FakeWebContents, views, gesture } = vi.hoisted(() => {
  let wcSeq = 0
  const views: FakeView[] = []
  /** Milliseconds since the last click per webContents id, as guest-session tracks it. */
  const gesture = new Map<number, number>()
  type Listener = (...args: unknown[]) => void
  type OpenHandler = (d: { url: string; disposition: string }) => {
    action: string
    overrideBrowserWindowOptions?: Record<string, unknown>
  }

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
    once(name: string, fn: Listener): void {
      let done = false
      this.on(name, (...args) => {
        if (done) return
        done = true
        fn(...args)
      })
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
    bounds: unknown = null
    setBounds(b: unknown): void {
      this.bounds = b
    }
  }
  return { FakeView, FakeWebContents, views, gesture }
})
type FakeView = InstanceType<typeof FakeView>

/** A popup window as Electron hands it to did-create-window. */
class FakePopup {
  webContents = new FakeWebContents()
  closed = false
  shownInactive = false
  isDestroyed = (): boolean => this.closed
  close = (): void => {
    this.closed = true
  }
  setOpacity(): void {}
  setIgnoreMouseEvents(): void {}
  showInactive(): void {
    this.shownInactive = true
  }
}

vi.mock('electron', () => ({
  app: {},
  ipcMain: {},
  dialog: {},
  BaseWindow: class {},
  BrowserWindow: class {},
  WebContentsView: FakeView,
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

vi.mock('./guest-session', () => ({
  GUEST_PARTITION: 'persist:browser',
  gestureAge: (wc: { id: number } | null) => (wc && gesture.get(wc.id)) ?? Infinity,
  consumeGesture: (wc: { id: number }) => gesture.delete(wc.id),
}))

import { setImmediate as nextTick } from 'node:timers/promises'
import { PAGE_GONE_CODE } from '@evaos/browser-core/address'
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

function makeHost(config = memoryConfig(), env = { hiddenWindow: false }): BrowserHost {
  const ctx = {
    env,
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
  gesture.clear()
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

  it('a tab opened for a scope not in front waits there as its active tab; the front is untouched', () => {
    host.setScope('page:agent:nova')
    const own = host.createTab(undefined, true)!
    host.setScope('page:dashboard')
    const front = host.createTab(undefined, true)!
    const before = host.snapshot()

    const t = host.createTab('https://nova.test/', true, { scope: 'page:agent:nova' })!
    expect(host.snapshot()).toEqual(before)
    expect(host.activeTabId()).toBe(front.id)
    expect(host.snapshot('page:agent:nova')).toMatchObject({
      activeId: t.id,
      scope: 'page:agent:nova',
      tabs: [{ id: own.id }, { id: t.id }],
    })

    // Activating for that scope picks what it shows next, again without touching the front.
    expect(host.activateTab(own.id, 'page:agent:nova')).toBe(own.id)
    expect(host.activeTabId()).toBe(front.id)
    expect(host.activateTab(front.id, 'page:agent:nova')).toBe(own.id)
    expect(host.setScope('page:agent:nova').activeId).toBe(own.id)
  })

  it("window.open from the active tab opens in its opener's scope without taking the front", async () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const wc = viewOf(host, a.id)!.webContents
    const deny = wc.openHandler!({ url: 'https://b.test/', disposition: 'foreground-tab' })
    expect(deny).toEqual({ action: 'deny' })
    await nextTick()
    const snap = host.snapshot()
    expect(snap.tabs).toHaveLength(2)
    expect(snap.activeId).toBe(a.id)
    expect(snap.tabs[1]!.url).toBe('https://b.test/')
    expect(sent.filter(([ch]) => ch === 'browser.popup').map(([, p]) => p)).toEqual([
      { tabId: snap.tabs[1]!.id, openerId: a.id, scope: 'A' },
    ])
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

  it('marks a Cmd-click popup background, and any slotted page may open one', async () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const b = host.createTab('https://b.test/', true)!
    host.setSlots([
      { tabId: a.id, x: 0, y: 0, width: 300, height: 300 },
      { tabId: b.id, x: 300, y: 0, width: 300, height: 300 },
    ])
    viewOf(host, a.id)!.webContents.openHandler!({
      url: 'https://c.test/',
      disposition: 'background-tab',
    })
    await nextTick()
    const popup = sent.filter(([ch]) => ch === 'browser.popup').map(([, p]) => p)
    expect(popup).toEqual([
      { tabId: host.snapshot().tabs[2]!.id, openerId: a.id, scope: 'A', background: true },
    ])
  })

  it('a click into a page makes it the active page', () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const b = host.createTab('https://b.test/', true)!
    expect(host.activeTabId()).toBe(b.id)
    viewOf(host, a.id)!.webContents.fire('focus')
    expect(host.activeTabId()).toBe(a.id)
    expect(sent.at(-1)).toEqual(['browser.tabs', host.snapshot()])
  })
})

describe('BrowserHost sign-in popups (T-01-37)', () => {
  const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'
  const opened = (): { tab: string; wc: FakeView['webContents'] } => {
    host.setScope('A')
    const t = host.createTab('https://app.test/login', true)!
    return { tab: t.id, wc: viewOf(host, t.id)!.webContents }
  }

  it('opens a real popup window in the guest partition right after a click, once per click', () => {
    const { wc } = opened()
    gesture.set(wc.id, 120)
    const res = wc.openHandler!({ url: GOOGLE, disposition: 'new-window' })
    expect(res.action).toBe('allow')
    expect(res.overrideBrowserWindowOptions).toMatchObject({
      show: true,
      webPreferences: {
        partition: 'persist:browser',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    // The click is used up: a second popup from the same gesture is refused.
    expect(wc.openHandler!({ url: GOOGLE, disposition: 'new-window' })).toEqual({ action: 'deny' })
    // about:blank (Auth0 opens it first, then points it at the provider) is a popup too.
    gesture.set(wc.id, 10)
    expect(wc.openHandler!({ url: 'about:blank', disposition: 'new-window' }).action).toBe('allow')
    expect(host.snapshot().tabs).toHaveLength(1)
  })

  it('refuses popups without a gesture, to other schemes, and from background tabs', async () => {
    const { tab, wc } = opened()
    expect(wc.openHandler!({ url: GOOGLE, disposition: 'new-window' })).toEqual({ action: 'deny' })
    gesture.set(wc.id, 10)
    for (const url of ['file:///etc/hosts', 'data:text/html,x', 'javascript:alert(1)']) {
      expect(wc.openHandler!({ url, disposition: 'new-window' })).toEqual({ action: 'deny' })
    }
    const other = host.createTab('https://b.test/', true)!
    expect(host.activeTabId()).toBe(other.id)
    expect(wc.openHandler!({ url: GOOGLE, disposition: 'new-window' })).toEqual({ action: 'deny' })
    // Other dispositions never open windows.
    host.activateTab(tab)
    expect(wc.openHandler!({ url: GOOGLE, disposition: 'save-to-disk' })).toEqual({
      action: 'deny',
    })
    await nextTick()
    expect(host.snapshot().tabs).toHaveLength(2)
  })

  it('a popup keeps the tab rules and closes with its opener page', async () => {
    const { wc } = opened()
    const popup = new FakePopup()
    wc.fire('did-create-window', popup, {})
    expect(popup.shownInactive).toBe(false)
    const pwc = popup.webContents
    // Links with target=_blank in the popup open as tabs of the opener's scope.
    pwc.openHandler!({ url: 'https://policies.google.com/terms', disposition: 'foreground-tab' })
    await nextTick()
    expect(host.snapshot().tabs.map((t) => t.url)).toEqual([
      'https://app.test/login',
      'https://policies.google.com/terms',
    ])
    // Its own popups follow the gesture rule in the popup.
    expect(pwc.openHandler!({ url: GOOGLE, disposition: 'new-window' })).toEqual({ action: 'deny' })
    const blocked = { preventDefault: vi.fn(), url: 'file:///etc/passwd' }
    pwc.fire('will-navigate', blocked)
    expect(blocked.preventDefault).toHaveBeenCalled()
    const ok = { preventDefault: vi.fn(), url: 'https://app.test/callback?code=1' }
    pwc.fire('will-redirect', ok)
    expect(ok.preventDefault).not.toHaveBeenCalled()
    wc.fire('destroyed')
    expect(popup.closed).toBe(true)
  })

  it('hidden test instances show the popup invisibly, never on screen', () => {
    host = makeHost(memoryConfig(), { hiddenWindow: true })
    const { wc } = opened()
    gesture.set(wc.id, 10)
    expect(wc.openHandler!({ url: GOOGLE, disposition: 'new-window' })).toMatchObject({
      action: 'allow',
      overrideBrowserWindowOptions: { show: false },
    })
    const popup = new FakePopup()
    wc.fire('did-create-window', popup, {})
    expect(popup.shownInactive).toBe(true)
  })
})

describe('BrowserHost passkey bar', () => {
  it('marks the tab when its page or its popup asks for a passkey; clears on success, dismiss or a new page', () => {
    host.setScope('A')
    const t = host.createTab('https://app.test/', true)!
    const wc = viewOf(host, t.id)!.webContents
    const passkey = (): boolean | undefined => host.snapshot().tabs[0]!.passkey

    host.passkey(wc.id, 'start')
    expect(passkey()).toBe(true)
    expect(sent.at(-1)).toEqual(['browser.tabs', host.snapshot()])
    host.passkey(wc.id, 'done')
    expect(passkey()).toBeUndefined()

    host.passkey(wc.id, 'start')
    host.dismissPasskey(t.id)
    expect(passkey()).toBeUndefined()

    host.passkey(wc.id, 'start')
    wc.fire('did-navigate-in-page', {}, 'https://app.test/#step2', true)
    expect(passkey()).toBe(true)
    wc.fire('did-navigate', {}, 'https://app.test/next')
    expect(passkey()).toBeUndefined()

    const popup = new FakePopup()
    wc.fire('did-create-window', popup, {})
    host.passkey(popup.webContents.id, 'start')
    expect(passkey()).toBe(true)
    popup.webContents.fire('destroyed')
    host.dismissPasskey(t.id)
    host.passkey(popup.webContents.id, 'start')
    expect(passkey()).toBeUndefined()
  })

  it('ignores senders that are not its tabs', () => {
    host.setScope('A')
    host.createTab('https://app.test/', true)
    const before = sent.length
    host.passkey(-1, 'start')
    expect(sent.length).toBe(before)
    expect(host.snapshot().tabs[0]!.passkey).toBeUndefined()
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
    const opened = host.snapshot().tabs.at(-1)!.id
    expect(opened).not.toBe(a.id)
    expect(host.snapshot().activeId).toBe(a.id)
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

  it('who opened a tab survives a relaunch and passes to the tabs its page opens', async () => {
    vi.useRealTimers()
    const first = makeHost(memoryConfig(files))
    first.setScope('chat:/a')
    const a = first.createTab('https://a.test/', true, { openedBy: 'Nova' })!
    expect(a.openedBy).toBe('Nova')
    viewOf(first, a.id)!.webContents.openHandler!({
      url: 'https://b.test/',
      disposition: 'foreground-tab',
    })
    await nextTick()
    const b = first.snapshot().tabs[1]!
    expect(b.openedBy).toBe('Nova')
    first.createTab('https://c.test/', true)
    first.dispose()
    const next = makeHost(memoryConfig(files))
    expect(next.setScope('chat:/a').tabs.map((t) => t.openedBy)).toEqual([
      'Nova',
      'Nova',
      undefined,
    ])
  })
})

describe('BrowserHost slots', () => {
  const R1 = { x: 0, y: 0, width: 400, height: 300 }
  const R2 = { x: 400, y: 0, width: 400, height: 300 }

  it('shows several tabs at once, each at its rect, and hides the rest', () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const b = host.createTab('https://b.test/', true)!
    const c = host.createTab('https://c.test/', true)!
    host.setSlots([
      { tabId: a.id, ...R1 },
      { tabId: b.id, ...R2 },
    ])
    expect(viewOf(host, a.id)).toMatchObject({ visible: true, bounds: R1 })
    expect(viewOf(host, b.id)).toMatchObject({ visible: true, bounds: R2 })
    expect(viewOf(host, c.id)!.visible).toBe(false)
    expect(host.setOccluded(true)).toBe(false)
    expect(viewOf(host, a.id)!.visible).toBe(false)
    expect(viewOf(host, b.id)!.visible).toBe(false)
    expect(host.setOccluded(false)).toBe(true)
    expect(viewOf(host, b.id)!.visible).toBe(true)
  })

  it('a tab dropped from the slots leaves the screen; an empty list shows nothing', () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const b = host.createTab('https://b.test/', true)!
    host.setSlots([
      { tabId: a.id, ...R1 },
      { tabId: b.id, ...R2 },
    ])
    host.setSlots([{ tabId: b.id, ...R2 }])
    expect(viewOf(host, a.id)!.visible).toBe(false)
    expect(viewOf(host, b.id)!.visible).toBe(true)
    host.setSlots([])
    expect(viewOf(host, b.id)!.visible).toBe(false)
  })

  it('a slotted tab of another scope stays live past LIVE_SCOPES; a dormant one revives', () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const a2 = host.createTab('https://a2.test/', true)!
    host.setScope('B')
    host.setSlots([{ tabId: a.id, ...R1 }])
    for (let i = 0; i < LIVE_SCOPES; i++) host.setScope(`other${i}`)
    expect(host.tabById(a.id)).toBeDefined()
    expect(host.tabById(a2.id)).toBeUndefined()
    expect(viewOf(host, a.id)!.visible).toBe(true)
    host.setSlots([{ tabId: a2.id, ...R2 }])
    const revived = viewOf(host, a2.id)!
    expect(revived.webContents.loadURL).toHaveBeenCalledWith('https://a2.test/')
    expect(revived).toMatchObject({ visible: true, bounds: R2 })
    expect(host.tabStates([a2.id, 't999999'])).toMatchObject([{ id: a2.id }])
  })

  it('a slotted tab that is not active may open pages beside itself', async () => {
    host.setScope('A')
    const a = host.createTab('https://a.test/', true)!
    const b = host.createTab('https://b.test/', true)!
    host.setSlots([{ tabId: a.id, ...R1 }])
    viewOf(host, a.id)!.webContents.openHandler!({
      url: 'https://c.test/',
      disposition: 'foreground-tab',
    })
    await nextTick()
    expect(host.snapshot().activeId).toBe(b.id)
    expect(sent).toContainEqual([
      'browser.popup',
      expect.objectContaining({ openerId: a.id, scope: 'A' }),
    ])
  })

  it('a page whose renderer dies or never starts shows the error card; Try again loads it anew', () => {
    host.setScope('A')
    const a = host.createTab('http://proto.test:4380/', true)!
    host.setSlots([{ tabId: a.id, ...R1 }])
    const view = viewOf(host, a.id)!
    expect(view.visible).toBe(true)
    // What macOS does past ~10k main-process descriptors: no did-fail-load, only this.
    view.webContents.fire('render-process-gone', {}, { reason: 'crashed', exitCode: 6 })
    expect(host.snapshot().tabs[0]).toMatchObject({
      loading: false,
      error: { host: 'proto.test:4380', code: PAGE_GONE_CODE },
    })
    expect(view.visible).toBe(false)
    host.reload(a.id)
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('http://proto.test:4380/')
    expect(host.snapshot().tabs[0]!.error).toBeNull()
    expect(view.visible).toBe(true)
  })
})
