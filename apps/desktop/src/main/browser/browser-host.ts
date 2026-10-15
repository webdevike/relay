import { WebContentsView, clipboard, shell } from 'electron'
import { BLOCKED_URL_CODE, LOADABLE_PROTOCOLS, loadableUrl } from '@evaos/browser-core/address'
import { matchesAppChord } from '@evaos/browser-core/hotkeys'
import type { TabState, TabsSnapshot } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit } from '../ipc/handle'
import { GUEST_PARTITION } from './guest-session'
import { HistoryStore } from './history-store'
import { PageControl } from './page-control'

export interface SlotRect {
  x: number
  y: number
  width: number
  height: number
}

interface Tab {
  view: WebContentsView
  state: TabState
  control?: PageControl
}

export interface NavigateOptions {
  /** The extension host may open its own `chrome-extension:` pages (popouts, options). */
  fromExtension?: boolean
}

/** Upper bound on open tabs; each one is a full renderer process a guest page could spawn. */
export const MAX_TABS = 32

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export class BrowserHost {
  private tabs = new Map<string, Tab>()
  private order: string[] = []
  private nextId = 1
  private activeId = ''
  private slot: SlotRect = { x: 0, y: 0, width: 0, height: 0 }
  private occluded = false
  private created: Array<(tab: TabState, view: WebContentsView) => void> = []
  private activated: Array<(tab: TabState, view: WebContentsView) => void> = []
  private closed: Array<(tab: TabState, view: WebContentsView) => void> = []

  readonly history: HistoryStore
  /** Resolves when the extension host is ready; navigation from IPC waits on it. */
  ready: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: MainContext) {
    this.history = new HistoryStore(ctx.config)
  }

  pageControl(tabId: string): PageControl {
    const t = this.tab(tabId)
    t.control ??= new PageControl(t.view.webContents)
    return t.control
  }

  onTabCreated(cb: (tab: TabState, view: WebContentsView) => void): void {
    this.created.push(cb)
  }

  onTabActivated(cb: (tab: TabState, view: WebContentsView) => void): void {
    this.activated.push(cb)
  }

  onTabClosed(cb: (tab: TabState, view: WebContentsView) => void): void {
    this.closed.push(cb)
  }

  /** Tab state and view by webContents id, for the extension host. */
  tabByWebContents(wcId: number): { id: string; view: WebContentsView } | undefined {
    for (const [id, t] of this.tabs) {
      if (!t.view.webContents.isDestroyed() && t.view.webContents.id === wcId) {
        return { id, view: t.view }
      }
    }
    return undefined
  }

  tabById(id: string): WebContentsView['webContents'] | undefined {
    return this.tabs.get(id)?.view.webContents
  }

  activeTabId(): string {
    return this.activeId
  }

  snapshot(): TabsSnapshot {
    return {
      tabs: this.order.map((id) => ({ ...this.tabs.get(id)!.state })),
      activeId: this.activeId,
    }
  }

  views(): WebContentsView[] {
    return this.order.map((id) => this.tabs.get(id)!.view)
  }

  activeView(): WebContentsView {
    return this.tabs.get(this.activeId)!.view
  }

  /** Returns null (and tells the shell why) once MAX_TABS are open. */
  createTab(url?: string, activate = false, opts: NavigateOptions = {}): TabState | null {
    if (this.order.length >= MAX_TABS) {
      emit(this.ctx, 'browser.notice', {
        message: `Tab limit reached (${MAX_TABS}). Close a tab to open another.`,
      })
      return null
    }
    const id = `t${this.nextId++}`
    const view = new WebContentsView({
      webPreferences: {
        partition: GUEST_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    const state: TabState = {
      id,
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      blank: true,
      error: null,
      favicon: null,
    }
    const tab: Tab = { view, state }
    this.tabs.set(id, tab)
    this.order.push(id)
    this.ctx.win.contentView.addChildView(view)
    view.setVisible(false)
    this.wire(tab)
    if (!this.activeId || activate) this.activeId = id
    for (const cb of this.created) cb(state, view)
    if (this.activeId === id) for (const cb of this.activated) cb(state, view)
    this.applyBounds()
    this.changed()
    if (url) this.navigate(id, url, opts)
    return { ...state }
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents
    const s = tab.state
    // Always deny; only http(s) foreground/background tab dispositions from the active tab
    // become app-created tabs in the same hardened partition (a background page cannot spawn
    // tabs). new-window popups stay denied (T-01-37).
    wc.setWindowOpenHandler((details) => {
      if (tab.state.id !== this.activeId) return { action: 'deny' }
      if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
        try {
          const p = new URL(details.url).protocol
          if (p === 'http:' || p === 'https:') {
            const fg = details.disposition === 'foreground-tab'
            setImmediate(() => {
              if (!this.ctx.win.isDestroyed()) this.createTab(details.url, fg)
            })
          }
        } catch {
          /* not a URL */
        }
      }
      return { action: 'deny' }
    })
    wc.on('before-input-event', (event, input) => {
      const chord = matchesAppChord(input)
      if (!chord) return
      event.preventDefault()
      if (chord === 'devtools') {
        wc.openDevTools({ mode: 'detach' })
        return
      }
      emit(this.ctx, 'browser.hotkey', { chord })
    })
    const guard = (event: { preventDefault(): void }, url: string): void => {
      try {
        if (!LOADABLE_PROTOCOLS.has(new URL(url).protocol)) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    }
    wc.on('will-navigate', (e) => guard(e, e.url))
    wc.on('will-redirect', (e) => guard(e, e.url))
    wc.on('page-title-updated', (_e, title) => {
      s.title = title
      this.history.title(wc.getURL(), title)
      this.changed()
    })
    wc.on('did-start-loading', () => {
      s.loading = true
      this.changed()
    })
    wc.on('did-stop-loading', () => {
      s.loading = false
      this.navState(tab)
      this.changed()
    })
    const nav = (url: string, counted: boolean): void => {
      s.url = url
      s.blank = false
      s.error = null
      // At did-navigate `s.title` still belongs to the previous page; count the visit without a
      // title and let page-title-updated supply the right one (an empty title never replaces).
      if (counted) this.history.visit(url, '')
      this.navState(tab)
      this.changed()
    }
    wc.on('did-navigate', (_e, url) => nav(url, true))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) nav(url, false)
    })
    wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      s.url = url
      s.blank = false
      s.loading = false
      s.error = { host: hostOf(url), code }
      this.navState(tab)
      this.changed()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      s.favicon = favicons[0] ?? null
      this.changed()
    })
  }

  private navState(tab: Tab): void {
    const h = tab.view.webContents.navigationHistory
    tab.state.canGoBack = h.canGoBack()
    tab.state.canGoForward = h.canGoForward()
  }

  private tab(id: string): Tab {
    const t = this.tabs.get(id)
    if (!t) throw Object.assign(new Error(`No such tab ${id}`), { code: 'no-such-tab' })
    return t
  }

  /**
   * The one place a guest view is told to load a URL (address bar, new tab, extension
   * createTab, error-card retry). Schemes outside the allow-list never reach loadURL: the tab
   * shows the error card under BLOCKED_URL_CODE instead, matching the will-navigate guard.
   */
  navigate(tabId: string, url: string, opts: NavigateOptions = {}): void {
    const t = this.tab(tabId)
    t.state.url = url
    t.state.blank = false
    if (!loadableUrl(url, opts)) {
      t.state.loading = false
      t.state.error = { host: hostOf(url), code: BLOCKED_URL_CODE }
      this.changed()
      return
    }
    t.state.error = null
    this.applyBounds()
    this.changed()
    t.view.webContents.loadURL(url).catch(() => {
      /* surfaced through did-fail-load */
    })
  }

  back(id: string): void {
    this.tab(id).view.webContents.navigationHistory.goBack()
  }
  forward(id: string): void {
    this.tab(id).view.webContents.navigationHistory.goForward()
  }
  reload(id: string): void {
    const t = this.tab(id)
    if (t.state.error) this.navigate(id, t.state.url)
    else t.view.webContents.reload()
  }
  stop(id: string): void {
    this.tab(id).view.webContents.stop()
  }
  copyLink(id: string): void {
    const url = this.tab(id).state.url
    if (url) clipboard.writeText(url)
  }
  openExternal(id: string): void {
    const url = this.tab(id).state.url
    try {
      const p = new URL(url).protocol
      if (p === 'http:' || p === 'https:') void shell.openExternal(url)
    } catch {
      /* not a URL */
    }
  }

  closeTab(id: string): string {
    const t = this.tab(id)
    const idx = this.order.indexOf(id)
    this.order.splice(idx, 1)
    this.tabs.delete(id)
    for (const cb of this.closed) cb(t.state, t.view)
    try {
      this.ctx.win.contentView.removeChildView(t.view)
    } catch {
      /* window already gone */
    }
    if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    if (this.order.length === 0) {
      this.activeId = ''
      this.createTab(undefined, true)
      return this.activeId
    }
    if (this.activeId === id) {
      this.activeId = this.order[idx] ?? this.order[idx - 1]!
      const next = this.tabs.get(this.activeId)!
      for (const cb of this.activated) cb(next.state, next.view)
    }
    this.changed()
    return this.activeId
  }

  activateTab(id: string): string {
    this.tab(id)
    this.activeId = id
    this.changed()
    const t = this.tab(id)
    for (const cb of this.activated) cb(t.state, t.view)
    return id
  }

  openDevTools(id: string): void {
    this.tab(id).view.webContents.openDevTools({ mode: 'detach' })
  }

  setSlot(rect: SlotRect): void {
    this.slot = rect
    this.applyBounds()
  }

  setOccluded(occluded: boolean): boolean {
    this.occluded = occluded
    this.applyBounds()
    return this.visible()
  }

  private visible(): boolean {
    const t = this.tabs.get(this.activeId)
    if (!t) return false
    return (
      !this.occluded &&
      !t.state.blank &&
      !t.state.error &&
      this.slot.width > 0 &&
      this.slot.height > 0
    )
  }

  private applyBounds(): void {
    for (const [id, t] of this.tabs) {
      if (id !== this.activeId) {
        t.view.setVisible(false)
        continue
      }
      t.view.setBounds(this.slot)
      const show = this.visible()
      const was = t.view.getVisible()
      t.view.setVisible(show)
      if (was && !show && !this.ctx.shell.webContents.isDestroyed()) {
        this.ctx.shell.webContents.focus()
      }
    }
  }

  private changed(): void {
    this.applyBounds()
    emit(this.ctx, 'browser.tabs', this.snapshot())
  }

  dispose(): void {
    this.history.flush()
    for (const t of this.tabs.values()) {
      try {
        this.ctx.win.contentView.removeChildView(t.view)
      } catch {
        /* window already gone */
      }
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    }
    this.tabs.clear()
    this.order = []
  }
}
