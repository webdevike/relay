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
import { placeOf } from '@evaos/shell-core'
import { listStore, type ListState } from '../chat/list/list-store'
import { setAgentTitles } from '../eva/names-store'
import { filesStore } from '../files/files-store'
import { navigateTo, resetTabsForTests, tabsStore } from '../tabs/tabs-store'
import { setOwnerResolver } from '../tabs/workspace-of'
import {
  resetTilingForTests,
  revealTool,
  startTiling,
  tabVisible,
  tilingStore,
} from '../tiling/tiling-store'
import { mountTestDock } from '../tiling/test-dock'
import { rendererActions } from './actions'
import { badgeStore, resetScopesForTests, resolveScope, startScopeWatch } from './scope'

const FILE = '/Users/ike/.omp/agent/sessions/-Eva/2026-10-27T10-00-00Z_01c3.jsonl'
const OWNED = '/Users/ike/.omp/agent/sessions/-Eva/2026-10-27T11-00-00Z_02aa.jsonl'
const row = { id: '01c3', file: FILE, title: 'Fix login' } as ChatRow
const owned = { id: '02aa', file: OWNED, title: 'ENG-1 auto-work' } as ChatRow
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
let stopTiling: () => void
let unmount: () => void
beforeEach(() => {
  resetTabsForTests()
  resetTilingForTests()
  tabsStore.setState({ loaded: true })
  resetScopesForTests()
  setAgentTitles({ nova: 'Nova' })
  listStore.setState({ list: { rows: [row, owned] } as unknown as ListState['list'] })
  setOwnerResolver((file) => (file === OWNED ? 'nova' : null))
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
  stopTiling = startTiling()
  unmount = mountTestDock()
  stopWatch = startScopeWatch()
  // Isaac is on the Dashboard with Files in front of the tool pane.
  revealTool('files')
})
afterEach(() => {
  stopWatch()
  stopTiling()
  unmount()
  setOwnerResolver(() => null)
})

describe('resolveScope', () => {
  it('maps page keys and workspace keys to the workspace', () => {
    for (const q of ['agent:nova', 'page:agent:nova']) {
      expect(resolveScope(q, [])).toEqual({
        scope: 'page:agent:nova',
        title: 'Nova',
        chatFile: null,
        actor: 'Nova',
      })
    }
    expect(resolveScope('test-bench', [])).toMatchObject({ scope: 'page:test-bench', actor: 'Eva' })
    // Every board is the Canvas page's workspace.
    expect(resolveScope('canvas:c1', []).scope).toBe('page:canvas')
    expect(resolveScope('draft:4', []).scope).toBe('draft:4')
  })

  it("maps a plain chat to its own workspace, an owned session to its assistant's", () => {
    const want = { scope: `chat:${FILE}`, title: 'Fix login', chatFile: FILE, actor: 'Eva' }
    expect(resolveScope('01c3', [row])).toEqual(want)
    expect(resolveScope(FILE, [row])).toEqual(want)
    expect(resolveScope(`chat:${FILE}`, [row])).toEqual(want)
    expect(resolveScope('/s/other.jsonl', [row])).toMatchObject({
      scope: 'chat:/s/other.jsonl',
      chatFile: '/s/other.jsonl',
    })
    expect(resolveScope('02aa', [row, owned])).toEqual({
      scope: 'page:agent:nova',
      title: 'Nova',
      chatFile: OWNED,
      actor: 'ENG-1 auto-work',
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

const visible = (id: string) => tabVisible(id)

describe('scoped content actions', () => {
  it('opens into a workspace not on screen, leaves the screen alone, and dots its row', async () => {
    const before = tilingStore.getState().panes
    const r = await rendererActions['browser.open']({ url: 'https://x.test/', scope: 'agent:nova' })
    expect(r).toMatchObject({ scope: 'page:agent:nova', background: true })
    expect(tilingStore.getState().scope).toBe('page:dashboard')
    expect(tilingStore.getState().panes).toBe(before)
    expect(badgeStore.getState().badges).toEqual({ 'page:agent:nova': 'Nova opened a page' })
    expect(invoke).toHaveBeenCalledWith(
      'browser.createTab',
      expect.objectContaining({ url: 'https://x.test/', scope: 'page:agent:nova' }),
    )
    // Quiet: no toast pops over what Isaac is looking at.
    expect(show).not.toHaveBeenCalled()
    // Isaac opens Nova: the page is there as her tab, and the dot is gone.
    navigateTo(placeOf('agent:nova'))
    expect(visible('web:t9')).toBe(true)
    await vi.waitFor(() => expect(badgeStore.getState().badges).toEqual({}))
  })

  it("an owned session's files.open lands in its assistant's workspace", async () => {
    const r = await rendererActions['files.open']({ path: '.omp/skills', scope: '02aa' })
    expect(r).toEqual({
      root: '/eva',
      path: '.omp/skills',
      kind: 'dir',
      scope: 'page:agent:nova',
      background: true,
    })
    expect(filesStore.getState().root).toBeNull()
    expect(tilingStore.getState().scope).toBe('page:dashboard')
    expect(badgeStore.getState().badges['page:agent:nova']).toBe('ENG-1 auto-work opened skills')
    // Nova's layout already has Files; it shows the moment Isaac opens her.
    const read = (await rendererActions['layout.read']({ scope: 'agent:nova' })) as {
      workspace: string
      shown: boolean
      panes: string[]
    }
    expect(read).toMatchObject({ workspace: 'page:agent:nova', shown: false })
    navigateTo(placeOf('agent:nova'))
    expect(visible('files')).toBe(true)
  })

  it("tab.open and pane.split change the caller's workspace, not the screen", async () => {
    const before = tilingStore.getState().panes
    const r = await rendererActions['tab.open']({ kind: 'terminal', scope: '01c3' })
    expect(r).toMatchObject({ tab: 'terminal', scope: `chat:${FILE}`, background: true })
    const split = (await rendererActions['pane.split']({
      dir: 'down',
      tab: { kind: 'files' },
      scope: '01c3',
    })) as { pane: string; layout: { workspace: string } }
    expect(split.layout.workspace).toBe(`chat:${FILE}`)
    expect(tilingStore.getState().panes).toBe(before)
    navigateTo(placeOf('chat', { chat: FILE }))
    expect(visible('terminal')).toBe(true)
    expect(visible('files')).toBe(true)
  })

  it('the workspace on screen runs as before', async () => {
    const r = await rendererActions['tab.open']({ kind: 'terminal', scope: 'dashboard' })
    expect(r).toMatchObject({ tab: 'terminal', scope: 'page:dashboard', background: false })
    expect(visible('terminal')).toBe(true)
    expect(badgeStore.getState().badges).toEqual({})
  })
})
