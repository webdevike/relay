import { activeTab, appPanelId, toolTabId, type Side, type WebTab } from '@evaos/shell-core'
import { browserStore, focusAddressOf } from '../browser/browser-store'
import { isDispatchFromGuest } from '../hotkeys/router'
import { invoke, on } from '../ipc'
import { tabsStore } from '../tabs/tabs-store'
import {
  addToolTab,
  closeTab,
  inWorkspace,
  legacyBrowserWorkspaces,
  paneSnapshot,
  replaceLegacyBrowser,
  tilingStore,
  workspaceHolding,
} from './tiling-store'

/**
 * Web pages as page tabs: each browser host tab is its own `{kind: 'web', id}` tool tab of the
 * workspace whose browser scope owns it (the workspace key is the scope), dragged, split and
 * arranged like any tab. Logins and cookies stay one shared session (the guest partition).
 */
export interface OpenWebPageOptions {
  /** What to load; a blank page (its address field focused) without one. */
  url?: string
  /** The pane it joins. */
  pane?: string
  /** A new pane that way beside the focused pane. */
  split?: Side
  /** Added without coming to the front or taking the focus. */
  background?: boolean
  /** The workspace (browser scope) it belongs to; default the one on screen. */
  scope?: string
  /** Who opened it, shown on its tab (a session's title, a helper's name). */
  openedBy?: string
}

export interface WebPagePlace {
  pane: string
  /** Its panel id, `web:<tabId>`. */
  tab: string
  /** The browser host tab. */
  tabId: string
}

export const webPanelId = (tabId: string): string => toolTabId({ kind: 'web', id: tabId })

/** The browser page a panel shows, or null for any other panel. */
export function webTabOf(panelId: string | null | undefined): string | null {
  return panelId?.startsWith('web:') ? panelId.slice('web:'.length) : null
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

interface Placement {
  pane?: string
  split?: Side
  background?: boolean
  /** A panel it goes right after, in that panel's pane (a page's popup beside it). */
  after?: string
}

/** Adds page `tabId` to the panes the engine holds now (see openWebPage); answers its pane. */
function placeWebTab(tabId: string, at: Placement): string {
  const tab: WebTab = { kind: 'web', id: tabId }
  const front = !at.background
  if (at.pane !== undefined) return addToolTab(tab, { pane: at.pane }, front)
  const { panes, focus } = paneSnapshot()
  const opener = at.after === undefined ? undefined : panes.find((p) => p.views.includes(at.after!))
  if (opener && at.after !== undefined) {
    return addToolTab(tab, { pane: opener.id, index: opener.views.indexOf(at.after) + 1 }, front)
  }
  if (at.split !== undefined && focus !== null) {
    return addToolTab(tab, { split: focus, side: at.split }, front)
  }
  const pages = panes.filter((p) => p.views.some((v) => webTabOf(v) !== null))
  const home = pages.find((p) => p.id === focus) ?? pages[0]
  if (home) return addToolTab(tab, { pane: home.id }, front)
  const thread = appPanelId(activeTab(tabsStore.getState().tabs).id)
  const chat = panes.find((p) => p.views.includes(thread)) ?? panes.find((p) => p.app) ?? panes[0]
  if (!chat) fail('not-found', 'The panes are not ready')
  return addToolTab(tab, { split: chat.id, side: 'right' }, front)
}

/**
 * Shows browser page `tabId` (a host tab already) as a page tab of workspace `scope` (default:
 * the one on screen; another one changes through inWorkspace, nothing on screen moves). Where it
 * goes: see openWebPage.
 */
export function showWebTab(tabId: string, opts: Placement & { scope?: string } = {}): WebPagePlace {
  const front = tilingStore.getState().scope
  const ws = opts.scope ?? front
  const place = (): string => placeWebTab(tabId, opts)
  const pane = ws === front ? place() : inWorkspace(ws, place)
  return { pane, tab: webPanelId(tabId), tabId }
}

/**
 * Opens a web page as a page tab: a new browser host tab in the workspace's scope, shown in
 * `pane` when given; else with `split` in a new pane beside the focused pane; else in the
 * workspace's pane holding pages (the focused one when it does); else in a new pane right of
 * the chat. `background` adds it without bringing it to the front or focusing it. A `scope` not
 * on screen changes through inWorkspace (no focus, no switch).
 */
export async function openWebPage(opts: OpenWebPageOptions = {}): Promise<WebPagePlace> {
  const front = tilingStore.getState().scope
  if (!front) fail('not-ready', 'The panes are not ready')
  const scope = opts.scope ?? front
  const r = await invoke('browser.createTab', {
    ...(opts.url ? { url: opts.url } : {}),
    scope,
    ...(opts.openedBy ? { openedBy: opts.openedBy } : {}),
    ...(opts.background ? { background: true } : {}),
  })
  if (!r.ok) fail(r.error.code, r.error.message)
  const page = r.value
  browserStore.getState().put([page])
  if (!opts.url && !opts.background && scope === tilingStore.getState().scope) {
    focusAddressOf(page.id)
  }
  return showWebTab(page.id, {
    scope,
    ...(opts.pane !== undefined ? { pane: opts.pane } : {}),
    ...(opts.split !== undefined ? { split: opts.split } : {}),
    ...(opts.background ? { background: true } : {}),
  })
}

/**
 * Cmd+T: a blank page in the focused pane, its address field focused. Sent from a page, it goes
 * to that page's pane.
 */
export function newPageTab(): void {
  const { activeId } = browserStore.getState()
  const fromPage = isDispatchFromGuest()
    ? paneSnapshot().panes.find((p) => p.views.includes(webPanelId(activeId)))?.id
    : undefined
  const pane = fromPage ?? tilingStore.getState().focus ?? undefined
  openWebPage(pane === undefined ? {} : { pane }).catch((e: unknown) => {
    console.warn('Could not open a page', e)
  })
}

/** A page a guest page or an extension opened: a page tab right after its opener's. */
function showPopup(p: {
  tabId: string
  openerId?: string
  scope: string
  background?: boolean
}): void {
  if (workspaceHolding(webPanelId(p.tabId)) !== null) return
  const opener = p.openerId === undefined ? null : webPanelId(p.openerId)
  const holder = opener === null ? null : workspaceHolding(opener)
  try {
    showWebTab(p.tabId, {
      scope: holder ?? p.scope,
      ...(opener !== null && holder !== null ? { after: opener } : {}),
      ...(p.background ? { background: true } : {}),
    })
  } catch (e) {
    console.warn(`Could not show page ${p.tabId}`, e)
  }
}

/** Turns the retired Browser panel of every saved layout into page tabs, once. */
async function replaceLegacyBrowsers(): Promise<void> {
  for (const ws of legacyBrowserWorkspaces()) {
    const r = await invoke('browser.state', { scope: ws })
    if (!r.ok) continue
    browserStore.getState().put(r.value.tabs)
    replaceLegacyBrowser(
      ws,
      r.value.tabs.map((t) => ({ id: t.id, pinned: t.pinned })),
      r.value.activeId,
    )
  }
}

/**
 * Keeps page tabs and browser pages together: a page a guest page or an extension opens shows
 * as a page tab beside its opener; a page the host closed (an extension, Cmd+W in the page)
 * takes its tab along; the page tab in front of the focused pane is the host's active page
 * (its extension actions, its eCard app); and the retired Browser panel of saved layouts turns
 * into page tabs once the panes are built. Returns the unsubscribe.
 */
export function startWebTabs(): () => void {
  const offPopup = on('browser.popup', showPopup)
  const offPages = browserStore.subscribe((s, prev) => {
    if (s.scope !== prev.scope || s.tabs === prev.tabs) return
    const live = new Set(s.tabs.map((t) => t.id))
    for (const t of prev.tabs) {
      const panel = webPanelId(t.id)
      if (live.has(t.id) || workspaceHolding(panel) !== tilingStore.getState().scope) continue
      try {
        closeTab(panel)
      } catch {
        // Gone already.
      }
    }
  })
  let asked = ''
  let migrated = false
  const sync = (): void => {
    const s = tilingStore.getState()
    if (!s.loaded) return
    if (!migrated) {
      migrated = true
      void replaceLegacyBrowsers()
    }
    const page = webTabOf(s.panes.find((p) => p.id === s.focus)?.active)
    const { activeId } = browserStore.getState()
    if (page === null || page === activeId) {
      asked = ''
      return
    }
    if (page === asked) return
    asked = page
    void invoke('browser.activateTab', { tabId: page })
  }
  sync()
  const offTiling = tilingStore.subscribe(sync)
  return () => {
    offPopup()
    offPages()
    offTiling()
  }
}
