import {
  BrowserWindow,
  WebContentsView,
  clipboard,
  shell,
  type HandlerDetails,
  type WebContents,
  type WindowOpenHandlerResponse,
} from 'electron'
import { BLOCKED_URL_CODE, loadableUrl } from '@evaos/browser-core/address'
import { isAppSwitchUrl } from '@evaos/browser-core/app-switch'
import { matchesAppChord } from '@evaos/browser-core/hotkeys'
import { FORWARD_FROM_GUEST, PINNED_SCOPE, chordOfInput } from '@evaos/shell-core'
import type { TabState, TabsSnapshot } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit } from '../ipc/handle'
import { allowGuestPopup } from './guest-permissions'
import { GUEST_PARTITION, consumeGesture, gestureAge } from './guest-session'
import { HistoryStore } from './history-store'
import { PageControl } from './page-control'
import { SavedTabsStore, type SavedBrowserTabs } from './saved-tabs'

export interface SlotRect {
  x: number
  y: number
  width: number
  height: number
}

interface Tab {
  /** Null while dormant: the tab's scope left the live set and only its state is kept. */
  view: WebContentsView | null
  state: TabState
  /** The scope that owns the tab; PINNED_SCOPE when pinned. */
  scope: string
  control?: PageControl
  /** Opened by the extension host: its own `chrome-extension:` pages may load and link to each other. */
  fromExtension?: boolean
  /** The saved URL a revived view is reloading; its did-navigate is not a new visit. */
  restoring?: string
  /**
   * The local eCard app this tab shows through the app switch: its requests to the switch carry
   * `ecard_app=<switchApp>` instead of the partition's cookie (tab-app-cookies.ts). Unset follows
   * the partition cookie.
   */
  switchApp?: string
}

export interface NavigateOptions {
  /** The extension host may open its own `chrome-extension:` pages (popouts, options). */
  fromExtension?: boolean
}

export interface CreateTabOptions extends NavigateOptions {
  /** The owning scope; the host's current scope when omitted. */
  scope?: string
  /** The tab's eCard app; the active tab's when omitted, so a new tab keeps the app it came from. */
  switchApp?: string
}

/** Upper bound on live tab views; each one is a full renderer process a guest page could spawn. */
export const MAX_TABS = 32

/** Scopes (most recently used first) whose tabs keep live views; pinned tabs always do. */
export const LIVE_SCOPES = 5

type TabListener = (tab: TabState, view: WebContentsView) => void

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * Guest browser tabs, each owned by one scope (the session or page in front) or pinned.
 * Snapshots and the shown view only ever cover the current scope: pinned tabs, then its own.
 */
export class BrowserHost {
  /** Insertion order is creation order. */
  private tabs = new Map<string, Tab>()
  private nextId = 1
  private scope = ''
  private activeId = ''
  /** The active tab each scope last had. */
  private lastActive = new Map<string, string>()
  /** Most recently used scopes first, at most LIVE_SCOPES. */
  private recent: string[] = []
  private slot: SlotRect = { x: 0, y: 0, width: 0, height: 0 }
  private occluded = false
  private created: TabListener[] = []
  private activated: TabListener[] = []
  private closed: TabListener[] = []
  /** Sign-in popups by webContents id, with the tab that opened them. */
  private popups = new Map<number, Tab>()

  readonly history: HistoryStore
  private readonly saved: SavedTabsStore
  /** Resolves when the extension host is ready; navigation from IPC waits on it. */
  ready: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: MainContext) {
    this.history = new HistoryStore(ctx.config)
    this.saved = new SavedTabsStore(ctx.config, () => this.toSaved())
    this.restore(this.saved.load())
  }

  /**
   * Brings back the last run's tabs as dormant tabs (no view, no load) in their scopes and
   * order. A scope's active tab revives when the scope is shown, the others when first
   * activated, so a launch loads one page and never moves focus.
   */
  private restore(saved: SavedBrowserTabs): void {
    for (const s of saved.tabs) {
      const pinned = s.scope === PINNED_SCOPE
      this.tabs.set(s.id, {
        view: null,
        scope: s.scope,
        ...(s.fromExtension ? { fromExtension: true } : {}),
        ...(s.switchApp ? { switchApp: s.switchApp } : {}),
        state: {
          id: s.id,
          url: s.url,
          title: s.title,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          blank: false,
          error: null,
          favicon: s.favicon,
          pinned,
        },
      })
      this.nextId = Math.max(this.nextId, Number(s.id.slice(1)) + 1)
    }
    for (const [scope, id] of Object.entries(saved.active)) this.lastActive.set(scope, id)
  }

  /** Every non-blank tab in creation order, and each scope's active tab (the front one's live). */
  private toSaved(): SavedBrowserTabs {
    const tabs: SavedBrowserTabs['tabs'] = []
    for (const [id, t] of this.tabs) {
      if (t.state.blank || !t.state.url) continue
      tabs.push({
        id,
        scope: t.scope,
        url: t.state.url,
        title: t.state.title,
        favicon: t.state.favicon,
        ...(t.fromExtension ? { fromExtension: true as const } : {}),
        ...(t.switchApp ? { switchApp: t.switchApp } : {}),
      })
    }
    const active = Object.fromEntries(this.lastActive)
    if (this.scope && this.activeId) active[this.scope] = this.activeId
    return { tabs, active }
  }

  pageControl(tabId: string): PageControl {
    const t = this.tab(tabId)
    const view = this.live(t)
    t.control ??= new PageControl(view.webContents, (url) => this.navigate(tabId, url))
    return t.control
  }

  /** A tab got a live view (a new tab, or a dormant one revived). */
  onTabCreated(cb: TabListener): void {
    this.created.push(cb)
  }

  onTabActivated(cb: TabListener): void {
    this.activated.push(cb)
  }

  /** A tab's view is gone (the tab closed, or went dormant). */
  onTabClosed(cb: TabListener): void {
    this.closed.push(cb)
  }

  /** Tab state and view by webContents id, for the extension host. */
  tabByWebContents(wcId: number): { id: string; view: WebContentsView } | undefined {
    for (const [id, t] of this.tabs) {
      if (t.view && !t.view.webContents.isDestroyed() && t.view.webContents.id === wcId) {
        return { id, view: t.view }
      }
    }
    return undefined
  }

  tabById(id: string): WebContentsView['webContents'] | undefined {
    return this.tabs.get(id)?.view?.webContents
  }

  /** The eCard app tab `id` shows through the app switch; undefined follows the partition cookie. */
  switchAppOf(id: string): string | undefined {
    return this.tabs.get(id)?.switchApp
  }

  /** The eCard app of the tab whose page made a request (webRequest's webContentsId). */
  switchAppOfWebContents(wcId: number): string | undefined {
    const hit = this.tabByWebContents(wcId)
    return hit ? this.tabs.get(hit.id)?.switchApp : undefined
  }

  /**
   * Points one tab at another eCard app and reloads it when it is on the switch; other tabs keep
   * theirs. `reload` is off when the page is already following a redirect to the new app.
   */
  setSwitchApp(id: string, app: string, reload = true): void {
    const t = this.tab(id)
    if (t.switchApp === app) return
    t.switchApp = app
    this.saved.dirty()
    if (!reload || !isAppSwitchUrl(t.state.url)) return
    // A first load still in flight has no entry to reload: start it again with the new app.
    if (t.view && !t.view.webContents.getURL()) this.navigate(id, t.state.url)
    else this.reload(id)
  }

  activeTabId(): string {
    return this.activeId
  }

  currentScope(): string {
    return this.scope
  }

  private visibleIds(scope = this.scope): string[] {
    const pinned: string[] = []
    const own: string[] = []
    for (const [id, t] of this.tabs) {
      if (t.scope === PINNED_SCOPE) pinned.push(id)
      else if (t.scope === scope) own.push(id)
    }
    return [...pinned, ...own]
  }

  /** The tabs `scope` shows (the scope in front by default) and its active tab. */
  snapshot(scope = this.scope): TabsSnapshot {
    return {
      tabs: this.visibleIds(scope).map((id) => ({ ...this.tabs.get(id)!.state })),
      activeId: scope === this.scope ? this.activeId : this.restoredActive(scope),
      scope,
    }
  }

  /** Every live view, whatever its scope. */
  views(): WebContentsView[] {
    const out: WebContentsView[] = []
    for (const t of this.tabs.values()) if (t.view) out.push(t.view)
    return out
  }

  activeView(): WebContentsView | undefined {
    return this.tabs.get(this.activeId)?.view ?? undefined
  }

  /**
   * Opens a tab in `opts.scope` (the current scope by default). Returns null (and tells the
   * shell why) once MAX_TABS views are live.
   */
  createTab(url?: string, activate = false, opts: CreateTabOptions = {}): TabState | null {
    if (this.views().length >= MAX_TABS) {
      emit(this.ctx, 'browser.notice', {
        message: `Tab limit reached (${MAX_TABS}). Close a tab to open another.`,
      })
      return null
    }
    const id = `t${this.nextId++}`
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
      pinned: false,
    }
    const scope = opts.scope ?? this.scope
    // A new tab follows the eCard app of the tab its own scope shows.
    const front = scope === this.scope ? this.activeId : this.restoredActive(scope)
    const switchApp = opts.switchApp ?? this.tabs.get(front)?.switchApp
    const tab: Tab = { view: null, state, scope, ...(switchApp ? { switchApp } : {}) }
    this.tabs.set(id, tab)
    this.spawnView(tab)
    if (scope === this.scope) {
      if (!this.activeId || activate) this.select(id)
    } else if (activate) {
      this.lastActive.set(scope, id)
    }
    this.changed()
    if (url) this.navigate(id, url, opts)
    return { ...state }
  }

  private spawnView(tab: Tab): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: GUEST_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    tab.view = view
    this.ctx.win.contentView.addChildView(view)
    view.setVisible(false)
    this.wire(tab, view)
    for (const cb of this.created) cb(tab.state, view)
    return view
  }

  /** The tab's view, revived (reloading its saved URL unless `loadSaved` is off) when dormant. */
  private live(t: Tab, loadSaved = true): WebContentsView {
    if (t.view) return t.view
    const view = this.spawnView(t)
    t.state.canGoBack = false
    t.state.canGoForward = false
    const url = t.state.url
    if (loadSaved && !t.state.blank && loadableUrl(url, { fromExtension: t.fromExtension })) {
      t.state.error = null
      t.restoring = url
      view.webContents.loadURL(url).catch(() => {
        /* surfaced through did-fail-load */
      })
    }
    return view
  }

  /** Closes the tab's view and keeps its state (url, title) as a dormant tab. */
  private discard(t: Tab): void {
    const view = t.view
    if (!view) return
    t.view = null
    t.control = undefined
    t.restoring = undefined
    t.state.loading = false
    for (const cb of this.closed) cb(t.state, view)
    try {
      this.ctx.win.contentView.removeChildView(view)
    } catch {
      /* window already gone */
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private wire(tab: Tab, view: WebContentsView): void {
    const wc = view.webContents
    const s = tab.state
    wc.setWindowOpenHandler((details) =>
      tab.view === view ? this.windowOpen(tab, wc, details) : { action: 'deny' },
    )
    wc.on('did-create-window', (win) => this.wirePopup(tab, win))
    wc.on('before-input-event', (event, input) => {
      if (matchesAppChord(input) === 'devtools') {
        event.preventDefault()
        wc.openDevTools({ mode: 'detach' })
        return
      }
      // Allow-listed chords only (T-02-23); plain typing, cmd+c and cmd+v stay with the page.
      const chord = chordOfInput(input)
      if (!chord || !FORWARD_FROM_GUEST.has(chord)) return
      event.preventDefault()
      emit(this.ctx, 'app.hotkey', { chord, fromGuest: true })
    })
    // Page-initiated navigations follow the same allow-list as navigate(); a tab the extension
    // host opened may move between its own chrome-extension: pages.
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (!loadableUrl(url, { fromExtension: tab.fromExtension })) event.preventDefault()
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
      // A revived tab reloading its saved page is not a new visit.
      if (counted && tab.restoring !== url) this.history.visit(url, '')
      tab.restoring = undefined
      this.navState(tab)
      this.changed()
    }
    wc.on('did-navigate', (_e, url) => {
      // A new document starts without the last one's passkey bar.
      delete s.passkey
      nav(url, true)
    })
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

  /**
   * Always decides here (T-01-37). Only the active tab (or a sign-in popup of it) opens anything,
   * and only web pages, in the same hardened partition:
   * - `foreground-tab`/`background-tab` (target=_blank, window.open without features): an
   *   app-created tab in the opener's scope. A pinned opener belongs to no session, so its tabs
   *   join the scope in front. A background page cannot spawn tabs.
   * - `new-window` (window.open with features, as "Sign in with Google/Apple/GitHub" buttons do):
   *   a real popup window that keeps `window.opener`, so the provider's postMessage and
   *   window.close flow works. Only right after a click or key press in the opener, one popup per
   *   gesture (allowGuestPopup); the popup gets the partition's permission policy like any tab.
   * Anything else is denied.
   */
  private windowOpen(
    tab: Tab,
    opener: WebContents,
    details: HandlerDetails,
  ): WindowOpenHandlerResponse {
    if (tab.state.id !== this.activeId || !tab.view) return { action: 'deny' }
    if (details.disposition === 'new-window') {
      if (!allowGuestPopup(details.url, gestureAge(opener))) return { action: 'deny' }
      consumeGesture(opener)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.ctx.win,
          // Hidden test instances show it in did-create-window, invisible like their window.
          show: !this.ctx.env.hiddenWindow,
          fullscreenable: false,
          backgroundColor: '#ffffff',
          webPreferences: {
            partition: GUEST_PARTITION,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
          },
        },
      }
    }
    if (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') {
      try {
        const p = new URL(details.url).protocol
        if (p === 'http:' || p === 'https:') {
          const fg = details.disposition === 'foreground-tab'
          const front = this.scope
          setImmediate(() => {
            if (this.ctx.win.isDestroyed()) return
            const scope = tab.scope === PINNED_SCOPE ? front : tab.scope
            this.createTab(details.url, fg, { scope, switchApp: tab.switchApp })
          })
        }
      } catch {
        /* not a URL */
      }
    }
    return { action: 'deny' }
  }

  /**
   * A sign-in popup of `tab`: the tab rules for what it opens and loads, closed with its opener's
   * page. The page's own window.close() closes it (Electron allows it for script-opened windows).
   */
  private wirePopup(tab: Tab, win: BrowserWindow): void {
    const wc = win.webContents
    const id = wc.id
    this.popups.set(id, tab)
    wc.once('destroyed', () => this.popups.delete(id))
    if (this.ctx.env.hiddenWindow) {
      win.setOpacity(0)
      win.setIgnoreMouseEvents(true)
      win.showInactive()
    }
    wc.setWindowOpenHandler((details) => this.windowOpen(tab, wc, details))
    wc.on('did-create-window', (child) => this.wirePopup(tab, child))
    const guard = (event: { preventDefault(): void }, url: string): void => {
      if (!loadableUrl(url)) event.preventDefault()
    }
    wc.on('will-navigate', (e) => guard(e, e.url))
    wc.on('will-redirect', (e) => guard(e, e.url))
    tab.view?.webContents.once('destroyed', () => {
      if (!win.isDestroyed()) win.close()
    })
  }

  /**
   * A guest page asked for a passkey (`start`) or got one (`done`), as the guest preload reports
   * (preload/guest.ts). A popup's request marks its opener tab. Unknown senders are ignored.
   */
  passkey(wcId: number, phase: 'start' | 'done'): void {
    const tab = this.popups.get(wcId) ?? this.tabs.get(this.tabByWebContents(wcId)?.id ?? '')
    if (!tab) return
    if (phase === 'start') tab.state.passkey = true
    else delete tab.state.passkey
    this.changed()
  }

  dismissPasskey(id: string): void {
    delete this.tab(id).state.passkey
    this.changed()
  }

  private navState(tab: Tab): void {
    if (!tab.view) return
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
    if (opts.fromExtension) t.fromExtension = true
    if (!loadableUrl(url, opts)) {
      // The view still shows the previous page, so `url`, `blank` and the history flags keep
      // describing it; the refused address travels in `error.host` for the card.
      t.state.loading = false
      t.state.error = { host: hostOf(url), code: BLOCKED_URL_CODE }
      this.changed()
      return
    }
    const view = this.live(t, false)
    t.restoring = undefined
    t.state.url = url
    t.state.blank = false
    t.state.error = null
    this.applyBounds()
    this.changed()
    view.webContents.loadURL(url).catch(() => {
      /* surfaced through did-fail-load */
    })
  }

  back(id: string): void {
    this.tab(id).view?.webContents.navigationHistory.goBack()
  }
  forward(id: string): void {
    this.tab(id).view?.webContents.navigationHistory.goForward()
  }
  reload(id: string): void {
    const t = this.tab(id)
    // A retry keeps the tab's extension status, so an errored chrome-extension: page can load.
    if (t.state.error) this.navigate(id, t.state.url, { fromExtension: t.fromExtension })
    else if (t.view) t.view.webContents.reload()
    else {
      this.live(t)
      this.changed()
    }
  }
  stop(id: string): void {
    this.tab(id).view?.webContents.stop()
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

  /** A scope may end up with no tabs; the panel then shows its empty new-tab state. */
  closeTab(id: string): string {
    const t = this.tab(id)
    const visible = this.visibleIds()
    const idx = visible.indexOf(id)
    this.tabs.delete(id)
    for (const [scope, tabId] of this.lastActive) if (tabId === id) this.lastActive.delete(scope)
    this.discard(t)
    if (this.activeId === id) {
      const rest = visible.filter((x) => x !== id)
      this.select(rest[idx] ?? rest[idx - 1] ?? '')
    }
    this.changed()
    return this.activeId
  }

  /**
   * Only a tab of the scope (or a pinned one) can become active. For a scope not in front it
   * becomes the tab that scope shows next; the tabs in front stay as they are.
   */
  activateTab(id: string, scope = this.scope): string {
    this.tab(id)
    if (scope !== this.scope) {
      if (!this.visibleIds(scope).includes(id)) return this.restoredActive(scope)
      this.lastActive.set(scope, id)
      this.saved.dirty()
      return id
    }
    if (!this.visibleIds().includes(id)) return this.activeId
    this.select(id)
    this.changed()
    return id
  }

  private select(id: string): void {
    this.activeId = id
    const t = this.tabs.get(id)
    if (!t) return
    const view = this.live(t)
    for (const cb of this.activated) cb(t.state, view)
  }

  /**
   * Shows `scope`: pinned tabs plus its own, with the tab it had active last (else its newest
   * own tab, else the first pinned one). Tabs of scopes beyond the LIVE_SCOPES most recent go
   * dormant; the restored active tab revives at once, the others when first activated.
   */
  setScope(scope: string): TabsSnapshot {
    if (scope === this.scope) return this.snapshot()
    if (this.activeId) this.lastActive.set(this.scope, this.activeId)
    this.scope = scope
    this.recent = [scope, ...this.recent.filter((s) => s !== scope)].slice(0, LIVE_SCOPES)
    const keep = new Set(this.recent)
    for (const t of this.tabs.values()) {
      if (t.scope !== PINNED_SCOPE && !keep.has(t.scope)) this.discard(t)
    }
    this.select(this.restoredActive())
    this.changed()
    return this.snapshot()
  }

  private restoredActive(scope = this.scope): string {
    const visible = this.visibleIds(scope)
    const remembered = this.lastActive.get(scope)
    if (remembered && visible.includes(remembered)) return remembered
    const own = visible.filter((id) => this.tabs.get(id)!.scope === scope)
    return own.at(-1) ?? visible[0] ?? ''
  }

  /** Moves every tab (and the remembered active tab) of `from` to `to`. */
  renameScope(from: string, to: string): void {
    if (from === to || from === PINNED_SCOPE || to === PINNED_SCOPE) return
    for (const t of this.tabs.values()) if (t.scope === from) t.scope = to
    const active = this.lastActive.get(from)
    this.lastActive.delete(from)
    if (active && !this.lastActive.has(to)) this.lastActive.set(to, active)
    this.recent = [...new Set(this.recent.map((s) => (s === from ? to : s)))]
    if (this.scope === from) this.scope = to
    this.changed()
  }

  /** Pinned tabs show in every scope; unpinning hands the tab to the current scope. */
  pinTab(id: string, pinned: boolean): TabsSnapshot {
    const t = this.tab(id)
    t.scope = pinned ? PINNED_SCOPE : this.scope
    t.state.pinned = pinned
    // Either way the tab stays in the visible set, so the active tab does not change.
    this.changed()
    return this.snapshot()
  }

  openDevTools(id: string): void {
    this.live(this.tab(id)).webContents.openDevTools({ mode: 'detach' })
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
    if (!t?.view) return false
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
      if (!t.view) continue
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
    this.saved.dirty()
  }

  /** Safe to call twice (window closed, then quit): only the first saves the tabs. */
  dispose(): void {
    this.saved.close()
    this.history.flush()
    for (const t of this.tabs.values()) {
      if (!t.view) continue
      try {
        this.ctx.win.contentView.removeChildView(t.view)
      } catch {
        /* window already gone */
      }
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    }
    this.tabs.clear()
  }
}
