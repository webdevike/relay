import { notifications } from '@mantine/notifications'
import type { AgentRunners, ChatRow, Result } from '@evaos/contract'
import { pageFromKey, placeOf } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { runAction } from '../hotkeys/router'
import { activate, activePlace, close, navigateTo, newChatTab, tabsStore } from '../tabs/tabs-store'
import { tabTitle } from '../tabs/tab-meta'
import {
  layoutStore,
  openExperimentArmPanel,
  openSubagentPanel,
  panelTabCreated,
  showPanelTool,
  togglePanel,
} from '../shell/layout-store'
import { chatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { listStore } from '../chat/list/list-store'
import { currentSpace, filesStore, showPath } from '../files/files-store'
import { requestExperiment } from '../test-bench/bench-request'
import { snapshotFocus } from './focus-safety'

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
  const layout = layoutStore.getState()
  const pane = chatStore.getState().panes[PANE_ID]
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
    tabs: tabs.list.map((t) => ({
      id: t.id,
      page: t.here.page,
      title: tabTitle(t.here),
      pinned: t.pinned,
      active: t.id === tabs.active,
    })),
    chat: pane ? { file: pane.file || null, title: pane.title, running: pane.running } : null,
    panel: { open: layout.panelOpen, view: layout.panelView, scope: layout.panelScope },
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
      panel: layout.panelOpen ? textOf('[data-testid=panel-card]') : '',
    },
  }
}

function describe(el: Element | null): string | null {
  if (!el || el === document.body) return null
  const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.className
  return `${el.tagName.toLowerCase()}${id ? ` ${String(id).slice(0, 80)}` : ''}`
}

export const rendererActions: AgentRunners<'renderer'> = {
  'page.open': ({ page, newTab, settingsSection, canvas, meeting }) => {
    const key = pageFromKey(page)
    if (!key) fail('invalid-params', `Unknown page ${page}`)
    navigateTo(
      placeOf(key, {
        ...(settingsSection ? { settingsSection } : {}),
        ...(canvas ? { canvas } : {}),
        ...(meeting ? { meeting } : {}),
      }),
      { newTab },
    )
    return { page: key }
  },
  'tab.focus': ({ id }) => {
    if (!tabsStore.getState().tabs.list.some((t) => t.id === id)) fail('not-found', `No tab ${id}`)
    activate(id)
    return { active: id }
  },
  'tab.close': ({ id }) => {
    if (!tabsStore.getState().tabs.list.some((t) => t.id === id)) fail('not-found', `No tab ${id}`)
    close(id)
    return { closed: id }
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
    const ready = await waitFor(() => chatStore.getState().panes[PANE_ID]?.file === '', 10_000)
    if (!ready) fail('not-ready', 'The new chat did not open')
    value(await invoke('chat.send', { paneId: PANE_ID, text: prompt }))
    return { sent: true }
  },
  'files.open': async ({ path, line, column }) => {
    showPanelTool('files')
    return showPath(path, chatStore.getState().panes[PANE_ID]?.file || null, { line, column })
  },
  'browser.open': async ({ url }) => {
    showPanelTool('browser')
    panelTabCreated()
    return value(await invoke('browser.createTab', { url }))
  },
  'browser.focusTab': async ({ tabId }) => {
    showPanelTool('browser')
    return value(await invoke('browser.activateTab', { tabId }))
  },
  'browser.closeTab': async ({ tabId }) => value(await invoke('browser.closeTab', { tabId })),
  'ecard.switch': async ({ id }) => {
    // Each tab has its own app: the list marks the front tab's, and a switch moves only that tab.
    const { activeId } = value(await invoke('browser.state', {}))
    const tabId = activeId || undefined
    const { apps } = value(await invoke('browser.switchApps', { tabId }))
    if (!id) return { apps }
    if (!apps.some((a) => a.id === id)) {
      fail('not-found', `No app ${id}; apps: ${apps.map((a) => a.id).join(', ')}`)
    }
    if (!tabId) fail('no-tab', 'Open a browser tab on the eCard app first')
    return value(await invoke('browser.switchApp', { tabId, id }))
  },
  'panel.show': ({ tool }) => {
    showPanelTool(tool)
    return { view: tool }
  },
  'panel.subagent': (view) => {
    openSubagentPanel(view)
    return { view: 'subagent' }
  },
  'panel.close': () => {
    togglePanel(false)
    return { open: false }
  },
  'testbench.open': async ({ experiment, arm }) => {
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
    requestExperiment(experiment)
    navigateTo(placeOf('test-bench'))
    if (arm && label !== null) openExperimentArmPanel({ experiment, arm, label })
    return { page: 'test-bench', experiment, arm: arm ?? null }
  },
  'toast.show': ({ message, title, color }) => {
    notifications.show({ title: title ?? 'Eva', message, color: color ?? 'blue' })
    return { shown: true }
  },
  'shortcut.run': ({ action }) => {
    runAction(action)
    return { ran: action }
  },
}
