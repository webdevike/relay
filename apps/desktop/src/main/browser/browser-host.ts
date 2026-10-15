import { WebContentsView, clipboard, shell } from 'electron'
import type { TabState, TabsSnapshot } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit } from '../ipc/handle'
import { GUEST_PARTITION } from './guest-session'

export interface SlotRect {
  x: number
  y: number
  width: number
  height: number
}

interface Tab {
  view: WebContentsView
  state: TabState
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'about:'])

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

  constructor(private readonly ctx: MainContext) {}

  onTabCreated(cb: (tab: TabState, view: WebContentsView) => void): void {
    this.created.push(cb)
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

  createTab(url?: string): TabState {
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
    if (!this.activeId) this.activeId = id
    for (const cb of this.created) cb(state, view)
    this.applyBounds()
    this.changed()
    if (url) this.navigate(id, url)
    return { ...state }
  }

  private wire(tab: Tab): void {
    const wc = tab.view.webContents
    const s = tab.state
    // 01-08 routes foreground-tab dispositions to new tabs; here every popup is denied.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: { preventDefault(): void }, url: string): void => {
      try {
        if (!ALLOWED_PROTOCOLS.has(new URL(url).protocol)) event.preventDefault()
      } catch {
        event.preventDefault()
      }
    }
    wc.on('will-navigate', (e) => guard(e, e.url))
    wc.on('will-redirect', (e) => guard(e, e.url))
    wc.on('page-title-updated', (_e, title) => {
      s.title = title
      this.changed()
    })
    wc.on('did-start-loading', () => {
      s.loading = true
      this.changed()
    })
    wc.on('did-stop-loading', () => {
      s.loading = false
      this.history(tab)
      this.changed()
    })
    const nav = (url: string): void => {
      s.url = url
      s.blank = false
      s.error = null
      this.history(tab)
      this.changed()
    }
    wc.on('did-navigate', (_e, url) => nav(url))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) nav(url)
    })
    wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      s.url = url
      s.blank = false
      s.loading = false
      s.error = { host: hostOf(url), code }
      this.history(tab)
      this.changed()
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      s.favicon = favicons[0] ?? null
      this.changed()
    })
  }

  private history(tab: Tab): void {
    const h = tab.view.webContents.navigationHistory
    tab.state.canGoBack = h.canGoBack()
    tab.state.canGoForward = h.canGoForward()
  }

  private tab(id: string): Tab {
    const t = this.tabs.get(id)
    if (!t) throw Object.assign(new Error(`No such tab ${id}`), { code: 'no-such-tab' })
    return t
  }

  navigate(tabId: string, url: string): void {
    const t = this.tab(tabId)
    t.state.url = url
    t.state.blank = false
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
    if (t.state.error) {
      t.state.error = null
      this.applyBounds()
      this.changed()
      t.view.webContents.loadURL(t.state.url).catch(() => {})
    } else t.view.webContents.reload()
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
