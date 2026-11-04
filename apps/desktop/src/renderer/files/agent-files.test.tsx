import { MantineProvider } from '@mantine/core'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
vi.mock('./CodeEditor', () => ({ CodeEditor: () => <div data-testid="monaco-stub" /> }))

import { EditorArea } from './EditorArea'
import {
  activateTab,
  agentFileKey,
  currentSpace,
  filesStore,
  followChat,
  openAgentFiles,
  openFile,
  resetFilesStoreForTests,
  showPath,
} from './files-store'

// jsdom has no scrollIntoView; the tab strip scrolls the active tab into view.
Element.prototype.scrollIntoView = vi.fn()

const version = { mtimeMs: 1, size: 3, hash: 'h' }
interface Opened {
  ok: true
  value: { root: string; name: string; prime: string; thread: string; remote: boolean }
}
const opened = (root: string, remote: boolean, prime: string, thread: string): Opened => ({
  ok: true,
  value: { root, name: 'nova instructions', prime, thread, remote },
})

/** Main as the Files panel sees it: `files.agent` answers `agentRoot`, everything else is plain. */
function main(agentRoot: Opened): void {
  invoke.mockImplementation((channel: string, input: { root?: string; path?: string }) => {
    switch (channel) {
      case 'files.agent':
        return Promise.resolve(agentRoot)
      case 'files.root':
        return Promise.resolve({ ok: true, value: { root: '/work/tree', name: 'tree' } })
      case 'files.list':
        return Promise.resolve({ ok: true, value: { entries: [] } })
      case 'files.read':
        return Promise.resolve({ ok: true, value: { kind: 'text', text: input.path, version } })
      case 'files.gitStatus':
        return Promise.resolve({
          ok: true,
          value: { repo: false, branch: null, changes: {}, ignored: [] },
        })
      default:
        return Promise.resolve({ ok: true, value: {} })
    }
  })
}

beforeEach(() => {
  invoke.mockReset()
  resetFilesStoreForTests()
})

const CHAT = '/sessions/nova.jsonl'

describe('openAgentFiles', () => {
  it('opens prime.md in front and thread.md as the second tab, in the root files.agent names', async () => {
    const prime = '.omp/assistant/agents/nova/prime.md'
    const thread = 'work/eva/agents/nova/thread.md'
    main(opened('/Users/ike/Eva', false, prime, thread))
    await openAgentFiles('nova', 'Nova', CHAT)
    const w = currentSpace(filesStore.getState())
    expect(filesStore.getState().root).toBe('/Users/ike/Eva')
    expect(w?.tabs.map((t) => t.path)).toEqual([prime, thread])
    expect(w?.active).toBe(prime)
    expect(w?.tabs.every((t) => t.pinned)).toBe(true)
    await waitFor(() =>
      expect(currentSpace(filesStore.getState())?.tabs[0]?.content).not.toBeNull(),
    )
    expect(filesStore.getState().agentFiles[agentFileKey('/Users/ike/Eva', prime)]).toEqual({
      agent: 'nova',
      title: 'Nova',
      kind: 'prime',
      remote: false,
    })
  })

  it('keeps the root while the same chat is followed, until another path is shown', async () => {
    main(opened('/relay-host/nova', true, 'prime.md', 'thread.md'))
    await openAgentFiles('nova', 'Nova', CHAT)
    invoke.mockClear()
    await followChat(CHAT)
    expect(invoke).not.toHaveBeenCalledWith('files.root', expect.anything())
    expect(filesStore.getState().root).toBe('/relay-host/nova')
    // Another chat gets its own worktree.
    await followChat('/sessions/other.jsonl')
    expect(filesStore.getState().root).toBe('/work/tree')
    // showPath on the chat leaves the pinned instructions.
    await followChat(CHAT)
    expect(filesStore.getState().root).toBe('/relay-host/nova')
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'files.root'
          ? { ok: true, value: { root: '/Users/ike/Eva', name: 'Eva' } }
          : channel === 'files.list'
            ? { ok: true, value: { entries: [] } }
            : { ok: true, value: {} },
      ),
    )
    await showPath('/Users/ike/Eva', CHAT)
    expect(filesStore.getState().root).toBe('/Users/ike/Eva')
  })

  it('a thin client opens the Mini virtual root and notes the files as remote', async () => {
    main(opened('/relay-host/nova', true, 'prime.md', 'thread.md'))
    await openAgentFiles('nova', 'Nova', null)
    expect(filesStore.getState().root).toBe('/relay-host/nova')
    expect(invoke).toHaveBeenCalledWith('files.agent', { agent: 'nova' })
    expect(invoke).toHaveBeenCalledWith('files.read', {
      root: '/relay-host/nova',
      path: 'prime.md',
    })
    expect(
      filesStore.getState().agentFiles[agentFileKey('/relay-host/nova', 'thread.md')],
    ).toMatchObject({
      kind: 'thread',
      remote: true,
    })
  })

  it('fails with the host reason when files.agent is refused', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'invalid-input', message: 'no' } })
    await expect(openAgentFiles('nova', 'Nova', null)).rejects.toThrow('no')
  })
})

describe('the instructions notice', () => {
  it('shows over prime.md only: changes apply when the assistant starts fresh', async () => {
    main(opened('/relay-host/nova', true, 'prime.md', 'thread.md'))
    await openAgentFiles('nova', 'Nova', null)
    render(
      <MantineProvider>
        <EditorArea root="/relay-host/nova" />
      </MantineProvider>,
    )
    const note = await screen.findByTestId('files-prime-note')
    expect(note).toHaveTextContent('Changes apply when Nova starts fresh; tell Nova to reload now.')
    // thread.md has no notice.
    act(() => activateTab('/relay-host/nova', 'thread.md'))
    expect(screen.queryByTestId('files-prime-note')).toBeNull()
  })

  it('does not show over an ordinary file', async () => {
    main(opened('/relay-host/nova', true, 'prime.md', 'thread.md'))
    await openAgentFiles('nova', 'Nova', null)
    act(() => openFile('/relay-host/nova', 'other.md', { pin: true }))
    render(
      <MantineProvider>
        <EditorArea root="/relay-host/nova" />
      </MantineProvider>,
    )
    await waitFor(() => expect(screen.getAllByRole('tab').length).toBe(3))
    expect(screen.queryByTestId('files-prime-note')).toBeNull()
  })
})
