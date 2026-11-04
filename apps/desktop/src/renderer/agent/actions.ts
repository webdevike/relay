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
  focusNeighbor,
  focusPaneById,
  layoutShape,
  moveTab,
  openArmTab,
  openPlaceBeside,
  openPlaceInPane,
  openTab,
  resizeNode,
  revealTool,
  splitAt,
  tilingStore,
  toolTabOfId,
  visiblePanes,
  zoomPane,
  closeAppTab,
} from '../tiling/tiling-store'
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
  const browser = await invoke('browser.state', {})
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
    browser: browser.ok ? browser.value : null,
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

/** The panes as agents read them (layout.read, state.read `layout`). */
export function layoutSnapshot(): Record<string, unknown> {
  const s = tilingStore.getState()
  const shown = visiblePanes(s).map((p) => p.id)
  const appTabs = tabsStore.getState().tabs
  const front = activeTab(appTabs).id
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
        active: n === front,
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
      visible: shown.includes(n.id),
      active: n.active,
      tabs: n.views.map(tab),
    }
  }
  const shape = layoutShape()
  return {
    root: shape ? node(shape) : null,
    focus: s.focus,
    zoom: s.zoom,
    panes: s.panes.map((p) => p.id),
  }
}

/** A tab spec's tool tab or page; an experiment arm's label comes from its run. */
async function paneTabOf(spec: PaneTabSpec): Promise<ToolTab | Place> {
  switch (spec.kind) {
    case 'browser':
    case 'files':
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

/** The app tab showing `place`, as its panel id. */
function placePanel(place: Place): string | null {
  const t = tabsStore.getState().tabs.list.find((x) => samePlace(x.here, place))
  return t ? appPanelId(t.id) : null
}

/**
 * Shows a tool tab or a page: in `pane` when one is named, else where it goes by default (a page
 * beside the app tab in front). Answers the pane and the tab's id.
 */
function showTab(what: ToolTab | Place, pane?: string): { pane: string; tab: string } {
  if (!isPlace(what)) return { pane: openTab(what, pane), tab: toolTabId(what) }
  if (pane !== undefined) openPlaceInPane(what, pane)
  else openPlaceBeside(what)
  const tab = placePanel(what) ?? placeKey(what)
  const at = tilingStore.getState().panes.find((p) => p.views.includes(tab))?.id ?? ''
  return { pane: at, tab }
}

/** What a spec's args ask of the tab's content once it shows (a URL, a file). */
async function showArgs(spec: PaneTabSpec, chatFile: string | null): Promise<object> {
  if (spec.kind === 'browser' && spec.args?.url) {
    return value(await invoke('browser.createTab', { url: spec.args.url }))
  }
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
 * An open tab's panel id from what agents name it: a panel id (`tab:3`, `browser`,
 * `subagent:…`), or a page's place key (`test-bench`, `review:pr:…`).
 */
function panelOf(id: string): string {
  if (tilingStore.getState().panes.some((p) => p.views.includes(id))) return id
  const t = tabsStore.getState().tabs.list.find((x) => placeKey(x.here) === id)
  if (t) return appPanelId(t.id)
  return fail('not-found', `No tab ${id}; layout.read lists them`)
}

/** A pane action's tab: an open tab's panel id, or a spec (opened, then moved). */
async function tabFor(tab: string | PaneTabSpec): Promise<string | ToolTab> {
  if (typeof tab === 'string') return panelOf(tab)
  const what = await paneTabOf(tab)
  if (!isPlace(what)) return what
  return placePanel(what) ?? showTab(what).tab
}

const shownChatFile = (): string | null =>
  chatStore.getState().panes[frontChatPaneOf()]?.file || null

const focusedPaneId = (): string =>
  tilingStore.getState().focus ?? fail('not-found', 'No pane has the focus')

/**
 * Runs a content action where it belongs: `front` in the tool tabs on screen (no scope, or the
 * named scope is the one in front), else `away` for that scope, shown when Isaac opens the page.
 * A named scope comes back in the result, with whether it was in the background.
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

/** Runs `show` for when Isaac opens a background scope, and badges its tab. */
function showAway(t: ScopeTarget, what: string, show: () => unknown): void {
  whenShown(t.scope, show)
  announce(t, what)
}

/** Fails unless browser tab `tabId` shows in `t`'s browser (its own tabs or a pinned one). */
async function tabIn(t: ScopeTarget, tabId: string): Promise<void> {
  const { tabs } = value(await invoke('browser.state', { scope: t.scope }))
  if (!tabs.some((x) => x.id === tabId)) fail('not-found', `No tab ${tabId} in ${t.title}`)
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
  'layout.read': () => layoutSnapshot(),
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
    return inScope(
      scope,
      async () => {
        const shown = showTab(await paneTabOf(spec), pane)
        return { ...shown, ...(await showArgs(spec, shownChatFile())) }
      },
      async (t) => {
        const what = await paneTabOf(spec)
        // The content goes to that scope now; the tab comes forward when Isaac opens it.
        let shown: object = {}
        if (spec.kind === 'browser' && spec.args?.url) {
          shown = value(await invoke('browser.createTab', { url: spec.args.url, scope: t.scope }))
        } else if (spec.kind === 'files' && spec.args?.path) {
          shown = await locatePath(spec.args.path, t.chatFile)
        }
        const title = isPlace(what) ? tabTitle(what) : paneTabTitle(what)
        showAway(t, `opened ${title}`, async () => {
          showTab(what, pane)
          if (spec.kind === 'page' && spec.args.item) openReviewItem(spec.args.item)
          if (spec.kind === 'files' && spec.args?.path) {
            const { path, line, column } = spec.args
            await showPath(path, t.chatFile, { line, column })
          }
        })
        return { tab: isPlace(what) ? placeKey(what) : toolTabId(what), ...shown }
      },
    )
  },
  'pane.split': async ({ pane, dir, tab, size }) => {
    const at = pane ?? focusedPaneId()
    const what = tab === undefined ? undefined : await tabFor(tab)
    const made = splitAt(at, dir, what, size)
    if (made === null)
      fail('nothing-to-split', `Pane ${at} has one tab and every tool is open; name a tab`)
    if (tab !== undefined && typeof tab !== 'string') await showArgs(tab, shownChatFile())
    return { pane: made, layout: layoutSnapshot() }
  },
  'pane.close': ({ pane }) => {
    closePaneById(pane)
    return { closed: pane, focus: tilingStore.getState().focus }
  },
  'pane.move': ({ tab, toPane, index }) => {
    moveTab(panelOf(tab), toPane, index)
    return { tab, pane: toPane }
  },
  'pane.resize': ({ pane, size, px }) => {
    resizeNode(pane, size !== undefined ? { share: size } : { px: px ?? 0 })
    return { pane, layout: layoutSnapshot() }
  },
  'pane.focus': ({ pane, dir }) => {
    if (pane !== undefined) focusPaneById(pane)
    else if (dir !== undefined && focusNeighbor(dir) === null) {
      fail('not-found', `No pane ${dir} of ${tilingStore.getState().focus}`)
    }
    return { focus: tilingStore.getState().focus }
  },
  'pane.zoom': ({ pane, on }) => {
    zoomPane(pane ?? focusedPaneId(), on)
    return { zoom: tilingStore.getState().zoom }
  },
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
        showAway(t, `opened ${shown.path.split('/').pop() || 'a folder'}`, () => {
          revealTool('files')
          return showPath(path, t.chatFile, { line, column })
        })
        return shown
      },
    ),
  'browser.open': ({ url, scope }) =>
    inScope(
      scope,
      async () => {
        revealTool('browser')
        return value(await invoke('browser.createTab', { url }))
      },
      async (t) => {
        const tab = value(await invoke('browser.createTab', { url, scope: t.scope }))
        showAway(t, 'opened a tab', () => revealTool('browser'))
        return tab
      },
    ),
  'browser.focusTab': ({ tabId, scope }) =>
    inScope(
      scope,
      async () => {
        revealTool('browser')
        return value(await invoke('browser.activateTab', { tabId }))
      },
      async (t) => {
        await tabIn(t, tabId)
        const r = value(await invoke('browser.activateTab', { tabId, scope: t.scope }))
        showAway(t, 'showed a tab', () => revealTool('browser'))
        return r
      },
    ),
  'browser.closeTab': ({ tabId, scope }) =>
    inScope(
      scope,
      async () => value(await invoke('browser.closeTab', { tabId })),
      async (t) => {
        await tabIn(t, tabId)
        const r = value(await invoke('browser.closeTab', { tabId }))
        announce(t, 'closed a tab')
        return r
      },
    ),
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
    const show = (): void => {
      openPlaceBeside(studio)
      if (job !== undefined) requestStudioOpen({ job })
      else if (draft !== undefined) requestStudioOpen({ draft })
    }
    const result = {
      tab: placeKey(studio),
      ...(job === undefined ? {} : { job }),
      draft: draft !== undefined,
    }
    return inScope(
      scope,
      () => {
        show()
        return result
      },
      (t) => {
        showAway(t, job === undefined ? 'opened Studio' : 'opened a Studio job', show)
        return result
      },
    )
  },
}
