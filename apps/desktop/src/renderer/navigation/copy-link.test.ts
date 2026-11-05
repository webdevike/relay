import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pageTab, placeOf, toolTabId, type ToolTab } from '@evaos/shell-core'

const { show } = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('@mantine/notifications', () => ({ notifications: { show } }))
const state = vi.hoisted(() => ({
  focus: 'p1' as string | null,
  panes: [] as { id: string; active: string | null; app: boolean }[],
  tools: new Map<string, unknown>(),
  tabs: [] as unknown[],
  web: [] as unknown[],
  files: null as unknown,
}))
vi.mock('../tiling/tiling-store', () => ({
  tilingStore: {
    getState: () => ({ focus: state.focus, panes: state.panes, scope: 'page:agent:nova' }),
  },
  toolTabOfId: (id: string) => state.tools.get(id) ?? null,
}))
vi.mock('../tabs/tabs-store', () => ({
  tabsStore: { getState: () => ({ tabs: { list: state.tabs } }) },
}))
vi.mock('../tabs/tab-meta', () => ({ tabTitle: () => 'Plan' }))
vi.mock('../tiling/pane-tab-meta', () => ({ paneTabTitle: () => 'Mind map' }))
vi.mock('../browser/browser-store', () => ({
  browserStore: { getState: () => ({ tabs: state.web }) },
}))
vi.mock('../files/files-store', () => ({
  filesStore: { getState: () => ({}) },
  currentSpace: () => state.files,
}))
vi.mock('../hotkeys/router', () => ({ registerAction: vi.fn() }))

import { copyFocusedLink } from './copy-link'

const focusTool = (tab: ToolTab): void => {
  const id = toolTabId(tab)
  state.tools.set(id, tab)
  state.panes = [
    { id: 'p0', active: 'tab:1', app: true },
    { id: 'p1', active: id, app: false },
  ]
  state.focus = 'p1'
}

beforeEach(() => {
  vi.clearAllMocks()
  state.tools.clear()
  state.tabs = [{ id: 1, here: placeOf('chat', { chat: '/s/a.jsonl' }) }]
  state.web = []
  state.files = null
})

describe('copyFocusedLink', () => {
  it("copies the chat's link from the main chat pane", async () => {
    state.panes = [{ id: 'p0', active: 'tab:1', app: true }]
    state.focus = 'p0'
    const write = vi.fn().mockResolvedValue(undefined)
    await copyFocusedLink(write)
    expect(write).toHaveBeenCalledWith('relay://open/chat?chat=%2Fs%2Fa.jsonl')
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Copied link to Plan' }))
  })

  it('copies a web tab: its URL and workspace', async () => {
    focusTool({ kind: 'web', id: 'w1' })
    state.web = [{ id: 'w1', url: 'https://example.com/', title: 'Example' }]
    const write = vi.fn().mockResolvedValue(undefined)
    await copyFocusedLink(write)
    expect(write).toHaveBeenCalledWith(
      'relay://open/web?url=https%3A%2F%2Fexample.com%2F&ws=page%3Aagent%3Anova',
    )
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Copied link to Example' }),
    )
  })

  it('copies the file open in Files, at its line', async () => {
    focusTool({ kind: 'files' })
    state.files = {
      root: '/e',
      active: 'src/a.ts',
      reveal: { path: 'src/a.ts', line: 9, column: 1, length: 0, nonce: 1 },
    }
    const write = vi.fn().mockResolvedValue(undefined)
    await copyFocusedLink(write)
    expect(write).toHaveBeenCalledWith(
      'relay://open/files?path=%2Fe%2Fsrc%2Fa.ts&line=9&ws=page%3Aagent%3Anova',
    )
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Copied link to a.ts' }))
  })

  it('copies a canvas board tab', async () => {
    focusTool(pageTab(placeOf('canvas', { canvas: 'mind-map' })))
    const write = vi.fn().mockResolvedValue(undefined)
    await copyFocusedLink(write)
    expect(write).toHaveBeenCalledWith('relay://open/canvas?canvas=mind-map')
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Copied link to Mind map' }),
    )
  })

  it('copies nothing for a tab without a link', async () => {
    focusTool({ kind: 'terminal' })
    const write = vi.fn()
    expect(await copyFocusedLink(write)).toBeNull()
    expect(write).not.toHaveBeenCalled()
  })
})
