import { notifications } from '@mantine/notifications'
import {
  PaneTabSpecSchema,
  pinId,
  type AgentRunners,
  type ChatRow,
  type PaneTabSpec,
  type Result,
} from '@evaos/contract'
import {
  activeTab,
  appPanelId,
  appTabOf,
  pageFromKey,
  pageTabPlace,
  placeKey,
  placeOf,
  samePlace,
  toolTabId,
  type DockShape,
  type Place,
  type ToolTab,
} from '@evaos/shell-core'
import { invoke } from '../ipc'
import { runAction } from '../hotkeys/router'
import { activate, activePlace, navigateTo, newChatTab, tabsStore } from '../tabs/tabs-store'
import { tabTitle } from '../tabs/tab-meta'
import {
  activateTab,
  closePaneById,
  closeTab,
  currentWorkspace,
  focusNeighbor,
  focusPaneById,
  frontWorkspace,
  inWorkspace,
  layoutShape,
  moveTab,
  openArmTab,
  openPlaceBeside,
  openPlaceInPane,
  openTab,
  paneSnapshot,
  resizeNode,
  revealTool,
  splitAt,
  tabVisible,
  tilingStore,
  toolTabOfId,
  visiblePanes,
  workspaceHolding,
  workspaceToolTabs,
  zoomPane,
  closeAppTab,
} from '../tiling/tiling-store'
import { openWebPage, showWebTab, webPanelId, type WebPagePlace } from '../tiling/web-tabs'
import { browserStore } from '../browser/browser-store'
import { paneTabTitle } from '../tiling/pane-tab-meta'
import { chatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { listStore } from '../chat/list/list-store'
import { currentSpace, filesStore, locatePath, showPath } from '../files/files-store'
import { requestExperiment } from '../test-bench/bench-request'
import { requestStudioOpen, studioStore } from '../studio/studio-store'
import { openReviewItem, reviewItemOf } from '../reviews/reviews-store'
import {
  contextStore,
  pinContext,
  queryFor,
  refreshContext,
  unpinContext,
} from '../context/context-store'
import { snapshotFocus } from './focus-safety'
import { announce, inFront, targetOf, whenShown, type ScopeTarget } from './scope'
import { accessActions } from './access'

/** A failure with a stable code; main reports it as `{ ok: false, code, message }`. */
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

function value<T>(r: Result<T>): T {
  if (!r.ok) fail(r.error.code, r.error.message)
  return r.value
}

const TEXT_CAP = 4000
function textOf(selector: string): string {
  const el = document.querySelector<HTMLElement>(selector)
  const text = (el?.innerText ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text
}

async function chatRows(): Promise<ChatRow[]> {
  if (!listStore.getState().list) await listStore.getState().load()
  return listStore.getState().list?.rows ?? []
}

/** One chat by session id, file path, exact title, or every word of its title. */
export function findChat(rows: readonly ChatRow[], query: string): ChatRow {
  const q = query.trim()
  const direct = rows.find((r) => r.id === q || r.file === q)
  if (direct) return direct
  const exact = rows.filter((r) => r.title.toLowerCase() === q.toLowerCase())
  if (exact.length === 1) return exact[0]!
  const words = q.toLowerCase().split(/\s+/)
  const hits = rows.filter((r) => words.every((w) => r.title.toLowerCase().includes(w)))
  if (hits.length === 1) return hits[0]!
  if (hits.length === 0) fail('not-found', `No chat matches "${q}"`)
  const some = hits.slice(0, 8).map((r) => `${r.title} (${r.id})`)
  return fail('ambiguous', `${hits.length} chats match "${q}": ${some.join('; ')}`)
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

/** The renderer half of state.read: what is on screen, without changing it. */
export async function readState(): Promise<Record<string, unknown>> {
  const tabs = tabsStore.getState().tabs
  const here = activePlace(tabsStore.getState())
  const pane = chatStore.getState().panes[frontChatPaneOf()]
  const space = currentSpace(filesStore.getState())
  const browser = await pagesOnScreen()
  return {
    page: {
      key: here.page,
      title: tabTitle(here),
      chat: here.chat,
      settingsSection: here.page === 'settings' ? here.settingsSection : null,
      canvas: here.canvas,
      meeting: here.meeting,
    },
    tabs: tabs.list.map((t, i) => ({
      id: t.id,
      page: t.here.page,
      title: tabTitle(t.here),
      pinned: t.pinned,
      active: i === tabs.active,
    })),
    chat: pane
      ? {
          file: pane.file || null,
          title: pane.title,
          running: pane.running,
          draft: composerText(),
        }
      : null,
    layout: layoutSnapshot(),
    browser,
    files: space
      ? {
          root: space.root,
          active: space.active,
          selected: space.selected,
          tabs: space.tabs.map((t) => t.path),
          expanded: [...space.expanded],
        }
      : null,
    focus: { ...snapshotFocus(), activeElement: describe(document.activeElement) },
    text: {
      main: textOf('[data-testid=main-card]'),
      panes: Object.fromEntries(
        visiblePanes()
          .filter((p) => !p.views.some((v) => v === appPanelId(activeTab(tabs).id)))
          .map((p) => [p.id, textOf(`[data-testid="pane-${p.id}"]`)]),
      ),
    },
  }
}

/**
 * state.read `browser`: the page tabs of the workspace on screen (pinned ones included), which of
 * them show, and the host's active page (the one last focused).
 */
async function pagesOnScreen(): Promise<Record<string, unknown>> {
  const ws = frontWorkspace()
  const ids = [...tilingStore.getState().pinned, ...workspaceToolTabs(ws)].flatMap((t) =>
    t.kind === 'web' ? [t.id] : [],
  )
  const r = ids.length > 0 ? await invoke('browser.tabs.get', { ids: ids.slice(0, 64) }) : null
  const pages = r?.ok ? r.value.tabs : []
  const { activeId } = browserStore.getState()
  return {
    workspace: ws,
    activeId: pages.some((p) => p.id === activeId) ? activeId : null,
    tabs: pages.map((p) => ({
      id: p.id,
      tab: webPanelId(p.id),
      url: p.url,
      title: p.title,
      loading: p.loading,
      shown: tabVisible(webPanelId(p.id)),
      pinned: p.pinned,
      ...(p.openedBy ? { openedBy: p.openedBy } : {}),
    })),
  }
}

function describe(el: Element | null): string | null {
  if (!el || el === document.body) return null
  const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.className
  return `${el.tagName.toLowerCase()}${id ? ` ${String(id).slice(0, 80)}` : ''}`
}

/** The chat composer's unsent text as shown, or null when no composer is on screen. */
function composerText(): string | null {
  const box = document.querySelector('[data-testid=composer-input]')
  return box instanceof HTMLTextAreaElement ? box.value : null
}

/** What layout.read shows of a tool tab beyond its kind: what it needs to show it again. */
function tabArgs(tab: ToolTab): Record<string, unknown> | undefined {
  switch (tab.kind) {
    case 'subagent':
      return { session: tab.session, file: tab.file, name: tab.name }
    case 'experiment-arm':
      return { experiment: tab.experiment, arm: tab.arm, label: tab.label }
    case 'page':
      return placeArgs(pageTabPlace(tab))
    case 'web':
      return { tabId: tab.id }
    default:
      return undefined
  }
}

/** A page's args as tab.open takes them. */
function placeArgs(p: Place): Record<string, unknown> {
  return {
    page: p.page,
    ...(p.page === 'chat' && p.chat ? { chat: p.chat } : {}),
    ...(p.page === 'canvas' && p.canvas ? { canvas: p.canvas } : {}),
    ...(p.page === 'meetings' && p.meeting ? { meeting: p.meeting } : {}),
    ...(p.page === 'settings' ? { settingsSection: p.settingsSection } : {}),
  }
}

/**
 * The panes as agents read them (layout.read, state.read `layout`): the workspace the engine
 * holds (inside inWorkspace, one not on screen).
 */
export function layoutSnapshot(): Record<string, unknown> {
  const s = paneSnapshot()
  const ws = currentWorkspace()
  const shownWs = ws === frontWorkspace()
  const shown = s.panes.filter((p) => s.zoom === null || p.id === s.zoom).map((p) => p.id)
  const appTabs = tabsStore.getState().tabs
  const front = activeTab(appTabs).id
  const { pinned } = tilingStore.getState()
  const tab = (id: string): Record<string, unknown> => {
    const n = appTabOf(id)
    if (n !== null) {
      const t = appTabs.list.find((x) => x.id === n)
      return {
        id,
        kind: 'app',
        app: n,
        title: t ? tabTitle(t.here) : id,
        ...(t ? { args: placeArgs(t.here) } : {}),
        active: shownWs && n === front,
        pinned: t?.pinned ?? false,
      }
    }
    const tool = toolTabOfId(id)
    const args = tool ? tabArgs(tool) : undefined
    return {
      id,
      kind: tool?.kind ?? 'tool',
      title: tool ? paneTabTitle(tool) : id,
      ...(args ? { args } : {}),
      pinned: pinned.some((p) => toolTabId(p) === id),
    }
  }
  const node = (n: DockShape): Record<string, unknown> => {
    if (n.type === 'split') {
      const total = n.children.reduce((a, c) => a + c.size, 0) || 1
      return {
        dir: n.dir,
        sizes: n.children.map((c) => Math.round((c.size / total) * 1000) / 1000),
        children: n.children.map(node),
      }
    }
    const view = s.panes.find((p) => p.id === n.id)
    return {
      pane: n.id,
      kind: view?.app ? 'app' : 'tool',
      rect: view?.rect ?? null,
      visible: shownWs && shown.includes(n.id),
      active: n.active,
      tabs: n.views.map(tab),
    }
  }
  const shape = layoutShape()
  return {
    workspace: ws,
    shown: shownWs,
    root: shape ? node(shape) : null,
    focus: s.focus,
    zoom: s.zoom,
    panes: s.panes.map((p) => p.id),
  }
}

/**
 * A tab spec's tool tab or page; an experiment arm's label comes from its run. A `browser` spec
 * opens its page (in `scope`'s browser, default the one on screen) and answers its page tab.
 */
async function paneTabOf(spec: PaneTabSpec, scope?: string): Promise<ToolTab | Place> {
  switch (spec.kind) {
    case 'browser': {
      const page = value(
        await invoke('browser.createTab', {
          ...(spec.args?.url ? { url: spec.args.url } : {}),
          ...(scope ? { scope } : {}),
        }),
      )
      browserStore.getState().put([page])
      return { kind: 'web', id: page.id }
    }
    case 'files':
    case 'terminal':
      return { kind: spec.kind }
    case 'subagent':
      return { kind: 'subagent', ...spec.args }
    case 'experiment-arm': {
      const { experiment, arm } = spec.args
      const detail = value(await invoke('experiments.get', { id: experiment }))
      const found = detail.armSummaries?.find((a) => a.id === arm)
      if (!found) fail('not-found', `No arm ${arm} in ${experiment}`)
      return { kind: 'experiment-arm', experiment, arm, label: found.label }
    }
    case 'page': {
      const { page, item, ...extra } = spec.args
      const key = pageFromKey(page)
      if (!key) fail('invalid-params', `Unknown page ${page}`)
      if (item !== undefined) checkReviewItem(key, item)
      return placeOf(key, extra)
    }
  }
}

const isPlace = (v: ToolTab | Place): v is Place => 'page' in v

/** The tab showing `place` in the workspace the engine holds: its app tab, else its page tab. */
function placePanel(place: Place): string | null {
  const views = paneSnapshot().panes.flatMap((p) => p.views)
  const t = tabsStore
    .getState()
    .tabs.list.find((x) => samePlace(x.here, place) && views.includes(appPanelId(x.id)))
  if (t) return appPanelId(t.id)
  return (
    views.find((v) => {
      const tab = toolTabOfId(v)
      return tab?.kind === 'page' && samePlace(pageTabPlace(tab), place)
    }) ?? null
  )
}

/**
 * Shows a tool tab or a page: in `pane` when one is named, else where it goes by default (a page
 * beside the chat in front, as a page tab). Answers the pane and the tab's id.
 */
function showTab(what: ToolTab | Place, pane?: string): { pane: string; tab: string } {
  if (!isPlace(what)) return { pane: openTab(what, pane), tab: toolTabId(what) }
  if (pane !== undefined) openPlaceInPane(what, pane)
  else openPlaceBeside(what)
  const tab = placePanel(what) ?? placeKey(what)
  const at = paneSnapshot().panes.find((p) => p.views.includes(tab))?.id ?? ''
  return { pane: at, tab }
}

/** What a spec's args ask of the tab's content once it shows (a file, a Reviews item). */
async function showArgs(spec: PaneTabSpec, chatFile: string | null): Promise<object> {
  if (spec.kind === 'files' && spec.args?.path) {
    const { path, line, column } = spec.args
    return showPath(path, chatFile, { line, column })
  }
  if (spec.kind === 'page' && spec.args.item) {
    openReviewItem(spec.args.item)
    return { item: spec.args.item }
  }
  return {}
}

/** Fails unless `item` is a link Reviews opens, on the Reviews page. */
function checkReviewItem(page: string, item: string): void {
  if (page !== 'reviews') fail('invalid-params', '`item` is for the reviews page only')
  if (!reviewItemOf(item)) {
    fail(
      'invalid-params',
      `Reviews opens GitHub pull requests, Linear issues and Slack messages, not ${item}`,
    )
  }
}

/**
 * An open tab's panel id from what agents name it: a panel id (`tab:3`, `files`, `web:<id>`,
 * `subagent:…`, `view:<key>`), or a page's place key (`test-bench`, `review:pr:…`).
 */
function panelOf(id: string): string {
  const views = paneSnapshot().panes.flatMap((p) => p.views)
  if (views.includes(id)) return id
  const t = tabsStore
    .getState()
    .tabs.list.find((x) => placeKey(x.here) === id && views.includes(appPanelId(x.id)))
  if (t) return appPanelId(t.id)
  if (views.includes(`view:${id}`)) return `view:${id}`
  return fail('not-found', `No tab ${id}; layout.read lists them`)
}

const shownChatFile = (): string | null =>
  chatStore.getState().panes[frontChatPaneOf()]?.file || null

const focusedPaneId = (): string =>
  paneSnapshot().focus ?? fail('not-found', 'No pane has the focus')

/**
 * Runs a content action where it belongs: `front` in the workspace on screen (no scope, or the
 * named scope's workspace is the one on screen), else `away` for that workspace, which changes
 * without showing. A named scope comes back in the result as its workspace, with whether it was
 * in the background.
 */
async function inScope(
  scope: string | undefined,
  front: () => object | Promise<object>,
  away: (t: ScopeTarget) => object | Promise<object>,
): Promise<object> {
  if (scope === undefined) return front()
  const t = await targetOf(scope)
  const background = !inFront(t)
  const result = await (background ? away(t) : front())
  return { ...result, scope: t.scope, background }
}

/**
 * An agent's change to a workspace not on screen: `layout` runs on its panes now (they change
 * without showing), `show` (content inside a tab: a file, a Studio job) runs when Isaac opens it,
 * and its sidebar row gets a quiet dot.
 */
function showAway(
  t: ScopeTarget,
  what: string,
  layout: (() => unknown) | null,
  show?: () => unknown,
): void {
  if (layout) inWorkspace(t.scope, layout)
  if (show) whenShown(t.scope, show)
  announce(t, what)
}

/** The workspace a layout action (layout.read, pane.*) names, or null for the one on screen. */
async function layoutTarget(scope: string | undefined): Promise<ScopeTarget | null> {
  if (scope === undefined) return null
  const t = await targetOf(scope)
  return inFront(t) ? null : t
}

/**
 * Runs `fn` on `t`'s panes (null: the workspace on screen). It runs synchronously: async work
 * (a tab spec's arm label) is done before, the hidden engine is gone after.
 */
function onLayout<T>(t: ScopeTarget | null, fn: () => T): T {
  return t === null ? fn() : inWorkspace(t.scope, fn)
}

/** Who an agent's page names as its opener: the session, when one an assistant owns acts. */
function openerOf(t: ScopeTarget): string | undefined {
  if (t.chatFile === null || !t.scope.startsWith('page:agent:')) return undefined
  return listStore.getState().list?.rows.find((r) => r.file === t.chatFile)?.title || undefined
}

/**
 * browser.open and tab.open `browser`: a page tab in the caller's workspace (see openWebPage),
 * in the background with a quiet dot when that workspace is not on screen.
 */
async function openPage(
  url: string | undefined,
  scope: string | undefined,
  pane: string | undefined,
): Promise<object> {
  const at = { ...(url ? { url } : {}), ...(pane !== undefined ? { pane } : {}) }
  if (scope === undefined) return openWebPage(at)
  const t = await targetOf(scope)
  const background = !inFront(t)
  const openedBy = openerOf(t)
  const placed: WebPagePlace = await openWebPage({
    ...at,
    scope: t.scope,
    ...(background ? { background: true } : {}),
    ...(openedBy ? { openedBy } : {}),
  })
  if (background) announce(t, 'opened a page')
  return { ...placed, scope: t.scope, background }
}

/** Fails unless browser page `tabId` exists. */
async function pageExists(tabId: string): Promise<void> {
  const { tabs } = value(await invoke('browser.tabs.get', { ids: [tabId] }))
  if (tabs.length === 0) fail('not-found', `No page ${tabId}; state.read lists them`)
}

/**
 * Lists the eCard app switch's apps with the active tab's marked (of `scope`, else in front);
 * with `id`, points only that tab at the app. Each tab has its own app.
 */
async function switchEcardApp(id: string | undefined, scope: string | undefined) {
  const { activeId } = value(await invoke('browser.state', scope ? { scope } : {}))
  const tabId = activeId || undefined
  const { apps } = value(await invoke('browser.switchApps', { tabId }))
  if (!id) return { apps }
  if (!apps.some((a) => a.id === id)) {
    fail('not-found', `No app ${id}; apps: ${apps.map((a) => a.id).join(', ')}`)
  }
  if (!tabId) fail('no-tab', 'Open a browser tab on the eCard app first')
  return value(await invoke('browser.switchApp', { tabId, id }))
}

export const rendererActions: AgentRunners<'renderer'> = {
  'page.open': ({ page, newTab, settingsSection, canvas, meeting, item }) => {
    const key = pageFromKey(page)
    if (!key) fail('invalid-params', `Unknown page ${page}`)
    if (item !== undefined) checkReviewItem(key, item)
    navigateTo(
      placeOf(key, {
        ...(settingsSection ? { settingsSection } : {}),
        ...(canvas ? { canvas } : {}),
        ...(meeting ? { meeting } : {}),
      }),
      { newTab },
    )
    if (item !== undefined) openReviewItem(item)
    return { page: key, ...(item === undefined ? {} : { item }) }
  },
  'layout.read': async ({ scope }) => onLayout(await layoutTarget(scope), layoutSnapshot),
  'tab.focus': ({ id }) => {
    if (typeof id === 'string') {
      const panel = panelOf(id)
      activateTab(panel)
      return { active: panel, pane: tilingStore.getState().focus }
    }
    if (!tabsStore.getState().tabs.list.some((t) => t.id === id)) fail('not-found', `No tab ${id}`)
    activate(id)
    return { active: id }
  },
  'tab.close': ({ id }) => {
    if (typeof id === 'string') {
      closeTab(panelOf(id))
      return { closed: id }
    }
    if (!tabsStore.getState().tabs.list.some((t) => t.id === id)) fail('not-found', `No tab ${id}`)
    closeAppTab(id)
    return { closed: id }
  },
  'tab.open': ({ kind, args, pane, scope }) => {
    const spec = PaneTabSpecSchema.parse(args === undefined ? { kind } : { kind, args })
    if (spec.kind === 'browser') return openPage(spec.args?.url, scope, pane)
    return inScope(
      scope,
      async () => {
        const shown = showTab(await paneTabOf(spec), pane)
        return { ...shown, ...(await showArgs(spec, shownChatFile())) }
      },
      async (t) => {
        const what = await paneTabOf(spec)
        // The content goes to that workspace now; inside a tab it shows when Isaac opens it.
        let shown: object = {}
        if (spec.kind === 'files' && spec.args?.path) {
          shown = await locatePath(spec.args.path, t.chatFile)
        }
        const title = isPlace(what) ? tabTitle(what) : paneTabTitle(what)
        let placed: { pane: string; tab: string } = { pane: '', tab: '' }
        showAway(
          t,
          `opened ${title}`,
          () => {
            placed = showTab(what, pane)
          },
          async () => {
            if (spec.kind === 'page' && spec.args.item) openReviewItem(spec.args.item)
            if (spec.kind === 'files' && spec.args?.path) {
              const { path, line, column } = spec.args
              await showPath(path, t.chatFile, { line, column })
            }
          },
        )
        return { ...placed, ...shown }
      },
    )
  },
  'pane.split': async ({ pane, dir, tab, size, scope }) => {
    const t = await layoutTarget(scope)
    const spec =
      tab === undefined || typeof tab === 'string' ? undefined : await paneTabOf(tab, t?.scope)
    const out = onLayout(t, () => {
      const at = pane ?? focusedPaneId()
      const what =
        tab === undefined
          ? undefined
          : typeof tab === 'string'
            ? panelOf(tab)
            : spec !== undefined && isPlace(spec)
              ? (placePanel(spec) ?? showTab(spec).tab)
              : spec
      const made = splitAt(at, dir, what, size)
      if (made === null) {
        fail('nothing-to-split', `Pane ${at} has one tab and every tool is open; name a tab`)
      }
      return { pane: made, layout: layoutSnapshot() }
    })
    if (tab !== undefined && typeof tab !== 'string') {
      if (t === null) await showArgs(tab, shownChatFile())
      else {
        if (tab.kind !== 'browser') whenShown(t.scope, () => showArgs(tab, t.chatFile))
        announce(t, 'split a pane')
      }
    }
    return out
  },
  'pane.close': async ({ pane, scope }) =>
    onLayout(await layoutTarget(scope), () => {
      closePaneById(pane)
      return { closed: pane, focus: paneSnapshot().focus }
    }),
  'pane.move': async ({ tab, toPane, index, scope }) =>
    onLayout(await layoutTarget(scope), () => {
      moveTab(panelOf(tab), toPane, index)
      return { tab, pane: toPane }
    }),
  'pane.resize': async ({ pane, size, px, scope }) =>
    onLayout(await layoutTarget(scope), () => {
      resizeNode(pane, size !== undefined ? { share: size } : { px: px ?? 0 })
      return { pane, layout: layoutSnapshot() }
    }),
  'pane.focus': async ({ pane, dir, scope }) =>
    onLayout(await layoutTarget(scope), () => {
      if (pane !== undefined) focusPaneById(pane)
      else if (dir !== undefined && focusNeighbor(dir) === null) {
        fail('not-found', `No pane ${dir} of ${paneSnapshot().focus}`)
      }
      return { focus: paneSnapshot().focus }
    }),
  'pane.zoom': async ({ pane, on, scope }) =>
    onLayout(await layoutTarget(scope), () => {
      zoomPane(pane ?? focusedPaneId(), on)
      return { zoom: paneSnapshot().zoom }
    }),
  'chat.open': async ({ query, newTab }) => {
    const row = findChat(await chatRows(), query)
    navigateTo(placeOf('chat', { chat: row.file }), { newTab })
    return { id: row.id, file: row.file, title: row.title }
  },
  'chat.new': () => {
    newChatTab()
    return { draft: true }
  },
  'chat.start': async ({ prompt }) => {
    newChatTab()
    const ready = await waitFor(() => {
      const id = frontChatPaneOf()
      return id !== '' && chatStore.getState().panes[id]?.file === ''
    }, 10_000)
    if (!ready) fail('not-ready', 'The new chat did not open')
    value(await invoke('chat.send', { paneId: frontChatPaneOf(), text: prompt }))
    return { sent: true }
  },
  'files.open': ({ path, line, column, scope }) =>
    inScope(
      scope,
      () => {
        revealTool('files')
        return showPath(path, shownChatFile(), { line, column })
      },
      async (t) => {
        const shown = await locatePath(path, t.chatFile)
        showAway(
          t,
          `opened ${shown.path.split('/').pop() || 'a folder'}`,
          () => revealTool('files'),
          () => showPath(path, t.chatFile, { line, column }),
        )
        return shown
      },
    ),
  'browser.open': ({ url, scope }) => openPage(url, scope, undefined),
  'browser.focusTab': async ({ tabId, scope }) => {
    const panel = webPanelId(tabId)
    const t = scope === undefined ? null : await targetOf(scope)
    const front = frontWorkspace()
    const ws = workspaceHolding(panel) ?? t?.scope ?? front
    if (workspaceHolding(panel) === null) await pageExists(tabId)
    const show = (): string => {
      const open = paneSnapshot().panes.find((p) => p.views.includes(panel))
      if (!open) return showWebTab(tabId).pane
      activateTab(panel)
      return open.id
    }
    if (ws === front) return { active: panel, pane: show() }
    const pane = inWorkspace(ws, show)
    announce(t !== null && t.scope === ws ? t : await targetOf(ws), 'showed a page')
    return { active: panel, pane, scope: ws, background: true }
  },
  'browser.closeTab': async ({ tabId, scope }) => {
    const panel = webPanelId(tabId)
    const ws = workspaceHolding(panel)
    if (ws === null) {
      value(await invoke('browser.closeTab', { tabId }))
      return { closed: tabId }
    }
    if (ws === frontWorkspace()) {
      closeTab(panel)
      return { closed: tabId }
    }
    inWorkspace(ws, () => closeTab(panel))
    const t = scope === undefined ? null : await targetOf(scope)
    announce(t !== null && t.scope === ws ? t : await targetOf(ws), 'closed a page')
    return { closed: tabId, scope: ws, background: true }
  },
  'ecard.switch': ({ id, scope }) =>
    inScope(
      scope,
      () => switchEcardApp(id, undefined),
      async (t) => {
        const r = await switchEcardApp(id, t.scope)
        if (id) announce(t, `switched a tab to ${id}`)
        return r
      },
    ),
  'testbench.open': async ({ experiment, arm, scope }) => {
    if (!experiment) {
      navigateTo(placeOf('test-bench'))
      return { page: 'test-bench' }
    }
    const detail = value(await invoke('experiments.get', { id: experiment }))
    let label: string | null = null
    if (arm) {
      const found = detail.armSummaries?.find((a) => a.id === arm)
      if (!found) {
        const ids = detail.armSummaries?.map((a) => a.id).join(', ') || 'none'
        fail('not-found', `No arm ${arm} in ${experiment}; arms: ${ids}`)
      }
      label = found.label
    }
    if (scope === undefined) {
      requestExperiment(experiment)
      navigateTo(placeOf('test-bench'))
      if (arm && label !== null) openArmTab({ experiment, arm, label })
      return { page: 'test-bench', experiment, arm: arm ?? null }
    }
    // The params schema only takes `scope` with `arm`: the arm details wait for that page.
    const view = { experiment, arm: arm!, label: label! }
    return inScope(
      scope,
      () => {
        openArmTab(view)
        return { experiment, arm: view.arm }
      },
      (t) => {
        showAway(t, `showed ${view.label}`, () => openArmTab(view))
        return { experiment, arm: view.arm }
      },
    )
  },
  'context.open': async ({ scope }) => {
    contextStore.setState({ scope: scope ?? 'here', open: true })
    const snap = await refreshContext()
    if (!snap) fail('not-ready', 'The context popover could not load')
    return snap
  },
  'context.read': async ({ scope }) => {
    const s = contextStore.getState()
    const here = activePlace(tabsStore.getState())
    return value(await invoke('context.get', queryFor(here, scope ?? s.scope, s.open)))
  },
  'context.pin': async ({ ref }) => {
    await pinContext(ref)
    return { pinned: pinId(ref) }
  },
  'context.unpin': async ({ id }) => {
    await unpinContext(id)
    return { unpinned: id }
  },
  'toast.show': ({ message, title, color }) => {
    notifications.show({ title: title ?? 'Eva', message, color: color ?? 'blue' })
    return { shown: true }
  },
  'shortcut.run': ({ action }) => {
    runAction(action)
    return { ran: action }
  },
  'studio.open': ({ job, draft, scope }) => {
    const { view } = studioStore.getState()
    if (job !== undefined && view.loaded && !view.jobs.some((j) => j.id === job)) {
      fail('not-found', `No Studio job ${job}; studio.list lists them`)
    }
    const studio = placeOf('studio')
    const ask = (): void => {
      if (job !== undefined) requestStudioOpen({ job })
      else if (draft !== undefined) requestStudioOpen({ draft })
    }
    const result = {
      tab: `view:${placeKey(studio)}`,
      ...(job === undefined ? {} : { job }),
      draft: draft !== undefined,
    }
    return inScope(
      scope,
      () => {
        openPlaceBeside(studio)
        ask()
        return result
      },
      (t) => {
        const what = job === undefined ? 'opened Studio' : 'opened a Studio job'
        showAway(t, what, () => openPlaceBeside(studio), ask)
        return result
      },
    )
  },
  ...accessActions,
}
