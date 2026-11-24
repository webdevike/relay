import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { BgJob, Subagent } from '@evaos/chat-core/message'
const { invoke, stat } = vi.hoisted(() => {
  const stat = { size: 10 }
  return {
    stat,
    invoke: vi.fn((channel: string, _input?: unknown): Promise<unknown> =>
      Promise.resolve({
        ok: true,
        value:
          channel === 'chat.readSubagent'
            ? { title: 't', messages: [] }
            : channel === 'chat.statSubagent'
              ? { mtimeMs: 1, size: stat.size }
              : {},
      }),
    ),
  }
})
vi.mock('../../ipc', () => ({
  invoke,
  on: () => () => undefined,
}))

import { chatStore } from '../chat-store'
import { SubagentTranscript } from '../SubagentTranscript'
import { JobsStrip, elapsed } from './JobsStrip'
import { StatusStrip } from './StatusStrip'

const sub = (name: string): Subagent => ({
  name,
  file: `${name}.jsonl`,
  done: true,
  failed: false,
  mtimeMs: 1,
  lastLine: '',
  tool: null,
})
const job = (id: string): BgJob => ({ id, label: `cmd ${id}`, kind: 'bash', startedAt: 1000 })
const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)

describe('SubagentTranscript', () => {
  it('reads the transcript read only and re-reads when the subagent file changes', async () => {
    invoke.mockClear()
    const file = '/s/chat/0-Scout.jsonl'
    const { rerender } = wrap(<SubagentTranscript file={file} version={1} />)
    expect(await screen.findByText('No messages yet.')).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith('chat.readSubagent', { file })
    rerender(
      <MantineProvider>
        <SubagentTranscript file={file} version={1} />
      </MantineProvider>,
    )
    expect(invoke.mock.calls.filter((c) => c[0] === 'chat.readSubagent')).toHaveLength(1)
    rerender(
      <MantineProvider>
        <SubagentTranscript file={file} version={2} />
      </MantineProvider>,
    )
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === 'chat.readSubagent')).toHaveLength(2),
    )
  })

  it('with poll, re-reads when the file grows and not before', async () => {
    const file = '/p/-proj/t_abc.jsonl'
    stat.size = 10
    invoke.mockClear()
    wrap(<SubagentTranscript file={file} version={null} poll />)
    await screen.findByText('No messages yet.')
    const reads = (): number => invoke.mock.calls.filter((c) => c[0] === 'chat.readSubagent').length
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('chat.statSubagent', { file }))
    expect(reads()).toBe(1)
    stat.size = 20
    await waitFor(() => expect(reads()).toBe(2), { timeout: 4000 })
  })

  it('shows a refused read as an error', async () => {
    invoke.mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: { code: 'outside-sessions-dir', message: 'Nope' } }),
    )
    wrap(<SubagentTranscript file="/x/y.jsonl" version={null} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope')
  })
})

describe('JobsStrip', () => {
  it('renders nothing when not running or without jobs', () => {
    const { rerender } = wrap(<JobsStrip running={false} jobs={[job('1')]} />)
    expect(screen.queryByTestId('jobs-strip')).toBeNull()
    rerender(
      <MantineProvider>
        <JobsStrip running jobs={[]} />
      </MantineProvider>,
    )
    expect(screen.queryByTestId('jobs-strip')).toBeNull()
  })

  it('pluralises and expands to rows with elapsed time', async () => {
    const user = userEvent.setup()
    const { rerender } = wrap(<JobsStrip running jobs={[job('1')]} now={() => 66_000} />)
    expect(screen.getByText('1 background job running')).toBeTruthy()
    rerender(
      <MantineProvider>
        <JobsStrip running jobs={[job('1'), job('2'), job('3')]} now={() => 66_000} />
      </MantineProvider>,
    )
    expect(screen.getByText('3 background jobs running')).toBeTruthy()
    await user.click(screen.getByRole('button'))
    expect(screen.getAllByTestId('jobs-row')).toHaveLength(3)
    expect(screen.getAllByTestId('jobs-elapsed')[0]).toHaveTextContent('1m 5s')
  })

  it('formats elapsed time', () => {
    expect(elapsed(4000)).toBe('4s')
    expect(elapsed(125_000)).toBe('2m 5s')
    expect(elapsed(3_700_000)).toBe('1h 1m')
  })
})

describe('chat-store extras', () => {
  const meta = { model: null, thinking: null, contextTokens: null }
  it('stores extras per pane, and holds them for a pane that is not open yet', () => {
    const s = chatStore.getState()
    s.openPane('pane-1', { file: '/s/x.jsonl', title: 't', messages: [], meta })
    chatStore.getState().setExtras({
      paneId: 'pane-1',
      running: true,
      subagents: [sub('a')],
      jobs: [job('1')],
    })
    expect(chatStore.getState().panes['pane-1']!.extras.jobs).toHaveLength(1)
    chatStore.getState().setExtras({
      paneId: 'pane-2',
      running: false,
      subagents: [sub('c')],
      jobs: [],
    })
    expect(chatStore.getState().pendingExtras['pane-2']!.subagents[0]!.name).toBe('c')
  })
})

describe('StatusStrip', () => {
  const meta = { model: null, thinking: null, contextTokens: null }
  const patch = (p: Record<string, unknown>, seq: number) =>
    act(() => chatStore.getState().applyOps('pane-1', [{ op: 'meta', patch: p }], seq))

  it('shows the goal with Pause or Resume and Drop, and the handoff over it', async () => {
    const user = userEvent.setup()
    chatStore.getState().openPane('pane-1', { file: '/s/x.jsonl', title: 't', messages: [], meta })
    const { container } = wrap(<StatusStrip paneId="pane-1" />)
    expect(container.querySelector('[data-testid="status-strip"]')).toBeNull()
    patch({ goal: { objective: 'ship it', paused: false, tokensUsed: 12_345 } }, 1)
    expect(screen.getByText('Goal')).toBeTruthy()
    expect(screen.getByText('ship it · 12k tokens')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Pause' }))
    expect(invoke).toHaveBeenCalledWith('chat.goal', { paneId: 'pane-1', op: 'pause' })
    patch({ goal: { objective: 'ship it', paused: true, tokensUsed: 0 } }, 2)
    expect(screen.getByText('Goal paused')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Resume' }))
    expect(invoke).toHaveBeenCalledWith('chat.goal', { paneId: 'pane-1', op: 'resume' })
    await user.click(screen.getByRole('button', { name: 'Drop' }))
    expect(invoke).toHaveBeenCalledWith('chat.goal', { paneId: 'pane-1', op: 'drop' })
    patch({ handingOff: true }, 3)
    expect(screen.getByText('Generating handoff')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Drop' })).toBeNull()
    patch({ handingOff: false, goal: null }, 4)
    expect(container.querySelector('[data-testid="status-strip"]')).toBeNull()
  })
})
