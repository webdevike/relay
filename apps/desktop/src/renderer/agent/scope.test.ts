import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a), hide: vi.fn() },
}))

import type { ChatRow } from '@evaos/contract'
import { listStore, type ListState } from '../chat/list/list-store'
import { setAgentTitles } from '../eva/names-store'
import { filesStore } from '../files/files-store'
import { isTabVisible } from '@evaos/shell-core'
import {
  activateTab,
  enterScope,
  resetTilingForTests,
  revealTool,
  tilingStore,
} from '../tiling/tiling-store'
import { rendererActions } from './actions'
import { badgeStore, resetScopesForTests, resolveScope, startScopeWatch } from './scope'

const FILE = '/Users/ike/.omp/agent/sessions/-Eva/2026-10-27T10-00-00Z_01c3.jsonl'
const row = { id: '01c3', file: FILE, title: 'Fix login' } as ChatRow
const tab = (id: string) => ({
  id,
  url: 'https://x.test/',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  blank: false,
  error: null,
  favicon: null,
  pinned: false,
})

let stopWatch: () => void
beforeEach(() => {
  resetTilingForTests()
  resetScopesForTests()
  setAgentTitles({ nova: 'Nova' })
  listStore.setState({ list: { rows: [row] } as unknown as ListState['list'] })
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, input: Record<string, unknown>) => {
    if (channel === 'browser.createTab') return { ok: true, value: tab('t9') }
    if (channel === 'browser.state') {
      return { ok: true, value: { tabs: [tab('t4')], activeId: 't4', scope: input.scope ?? '' } }
    }
    if (channel === 'files.root') return { ok: true, value: { root: '/eva', name: 'Eva' } }
    if (channel === 'files.list') return { ok: true, value: { entries: [] } }
    return { ok: true, value: {} }
  })
  show.mockReset()
  stopWatch = startScopeWatch()
  // Isaac is on the Dashboard with Files in front of the tool pane.
  enterScope('page:dashboard')
  revealTool('files')
})
afterEach(() => stopWatch())

describe('resolveScope', () => {
  it('maps page keys and their browser scopes to the page', () => {
    for (const q of ['agent:nova', 'page:agent:nova']) {
      expect(resolveScope(q, [])).toEqual({
        scope: 'page:agent:nova',
        title: 'Nova',
        chatFile: null,
        actor: 'Nova',
      })
    }
    expect(resolveScope('test-bench', [])).toMatchObject({ scope: 'page:test-bench', actor: 'Eva' })
    expect(resolveScope('canvas:c1', []).scope).toBe('page:canvas:c1')
  })

  it('maps a chat by session id or file, listed or not, to its chat page', () => {
    const want = { scope: `chat:${FILE}`, title: 'Fix login', chatFile: FILE, actor: 'Eva' }
    expect(resolveScope('01c3', [row])).toEqual(want)
    expect(resolveScope(FILE, [row])).toEqual(want)
    expect(resolveScope(`chat:${FILE}`, [row])).toEqual(want)
    expect(resolveScope('/s/other.jsonl', [row])).toMatchObject({
      scope: 'chat:/s/other.jsonl',
      chatFile: '/s/other.jsonl',
    })
  })

  it('rejects what names no page or chat', () => {
    for (const q of ['chat', 'nope', '/tmp/x.txt']) {
      expect(() => resolveScope(q, [row])).toThrow(
        expect.objectContaining({ code: 'invalid-scope' }),
      )
    }
  })
})

const visible = (id: string) => isTabVisible(tilingStore.getState().tiling, id)

describe('scoped content actions', () => {
  it("browser.open for a page not in front opens in that page's browser and leaves the front alone", async () => {
    const before = tilingStore.getState().tiling
    const r = await rendererActions['browser.open']({ url: 'https://x.test/', scope: 'agent:nova' })

    expect(r).toMatchObject({ id: 't9', scope: 'page:agent:nova', background: true })
    expect(invoke).toHaveBeenCalledWith('browser.createTab', {
      url: 'https://x.test/',
      scope: 'page:agent:nova',
    })
    expect(tilingStore.getState().scope).toBe('page:dashboard')
    expect(tilingStore.getState().tiling).toBe(before)
    // No app tab shows Nova's page: a toast says what happened, and the badge waits for a tab.
    expect(badgeStore.getState().badges).toEqual({ 'page:agent:nova': 'Nova opened a tab' })
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Nova opened a tab in Nova' }),
    )

    // Isaac opens Nova's page: the browser comes forward and the badge is gone.
    enterScope('page:agent:nova')
    await vi.waitFor(() => expect(visible('browser')).toBe(true))
    expect(badgeStore.getState().badges).toEqual({})
  })

  it('files.open for a chat not in front checks the path but opens nothing until Isaac goes there', async () => {
    const r = await rendererActions['files.open']({ path: '.omp/skills', scope: '01c3' })
    expect(r).toEqual({
      root: '/eva',
      path: '.omp/skills',
      kind: 'dir',
      scope: `chat:${FILE}`,
      background: true,
    })
    expect(filesStore.getState().root).toBeNull()
    expect(tilingStore.getState().scope).toBe('page:dashboard')
    expect(badgeStore.getState().badges[`chat:${FILE}`]).toBe('Eva opened skills')
  })

  it('browser.focusTab fails for a tab the scope does not show', async () => {
    await expect(
      rendererActions['browser.focusTab']({ tabId: 't1', scope: 'agent:nova' }),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(
      await rendererActions['browser.focusTab']({ tabId: 't4', scope: 'agent:nova' }),
    ).toMatchObject({ scope: 'page:agent:nova', background: true })
    expect(invoke).toHaveBeenCalledWith('browser.activateTab', {
      tabId: 't4',
      scope: 'page:agent:nova',
    })
  })

  it('tab.open for a page not in front waits for it, then brings the tab forward', async () => {
    activateTab('browser')
    const r = await rendererActions['tab.open']({ kind: 'files', scope: 'agent:nova' })
    expect(r).toMatchObject({ tab: 'files', scope: 'page:agent:nova', background: true })
    expect(visible('files')).toBe(false)
    enterScope('page:agent:nova')
    await vi.waitFor(() => expect(visible('files')).toBe(true))
  })

  it('the scope in front runs as before', async () => {
    const r = await rendererActions['tab.open']({ kind: 'browser', scope: 'dashboard' })
    expect(r).toEqual({ pane: 'p2', tab: 'browser', scope: 'page:dashboard', background: false })
    expect(visible('browser')).toBe(true)
    expect(badgeStore.getState().badges).toEqual({})
  })
})
