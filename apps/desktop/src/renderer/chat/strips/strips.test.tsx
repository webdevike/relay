import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { BgJob, Subagent } from '@evaos/chat-core/message'
import type { ActivityItem } from '@evaos/chat-core/activity'
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
import { SubagentChips } from './SubagentChips'
import { JobsStrip, elapsed } from './JobsStrip'
import { StatusStrip } from './StatusStrip'

const sub = (
  name: string,
  done: boolean,
  lastLine = '',
  mtimeMs = done ? 1 : Date.now(),
): Subagent => ({
  name,
  file: `${name}.jsonl`,
  done,
  failed: false,
  mtimeMs,
  lastLine,
  tool: null,
})
const job = (id: string): BgJob => ({ id, label: `cmd ${id}`, kind: 'bash', startedAt: 1000 })
const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)

const work = (
  id: string,
  kind: ActivityItem['kind'],
  status: ActivityItem['status'],
  open: ActivityItem['open'],
): ActivityItem => ({
  id,
  kind,
  owner: 'assistant:nova',
  title: id,
  status,
  intent: 'Running the tests',
  startedAt: 1,
  updatedAt: 1,
  open,
})

describe('SubagentChips activity badges', () => {
  it('a badge per in-progress session, harness or canvas agent, with its kind icon, opened through the same call', async () => {
    const user = userEvent.setup()
    const opened = vi.fn()
    const session = work('session:aw1', 'session', 'working', {
      to: 'chat',
      thread: 'session:aw1',
      session: 'aw1',
    })
    const harness = work('harness:w1:p3', 'harness', 'waiting', { to: 'terminal', pane: 'w1:p3' })
    const canvas = work('canvas:roadmap', 'canvas', 'working', { to: 'canvas', slug: 'roadmap' })
    wrap(
      <SubagentChips
        subagents={[sub('b', false)]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        activity={[session, harness, canvas]}
        onOpenActivity={opened}
      />,
    )
    // The helper's badge stays, and carries the helper icon beside its state.
    expect(screen.getByTestId('subagent-chip-b').querySelectorAll('svg')).toHaveLength(1)
    for (const [item, kind, state] of [
      [session, 'session', 'running'],
      [harness, 'harness', 'waiting'],
      [canvas, 'canvas', 'running'],
    ] as const) {
      const chip = screen.getByTestId(`activity-chip-${item.id}`)
      expect(chip).toHaveAttribute('data-kind', kind)
      expect(chip).toHaveAttribute('data-state', state)
      expect(chip.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
    }
    await user.click(screen.getByTestId('activity-chip-harness:w1:p3'))
    expect(opened).toHaveBeenCalledWith(harness, false)
  })

  it("an activity chip's hover says the session's title, model and how long it has run", async () => {
    const user = userEvent.setup()
    const session: ActivityItem = {
      ...work('session:abc', 'session', 'working', {
        to: 'chat',
        thread: 'session:abc',
        session: 'abc',
      }),
      title: 'Per-chat isolated pane layouts',
      model: 'claude-opus-5-5',
      startedAt: Date.now() - 7 * 60_000,
    }
    wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        activity={[session]}
      />,
    )
    await user.hover(screen.getByTestId('activity-chip-session:abc'))
    const tip = await screen.findByTestId('activity-chip-tip-session:abc')
    expect(tip).toHaveTextContent('Per-chat isolated pane layouts')
    expect(tip).toHaveTextContent('claude-opus-5-5 · running 7m')
    expect(tip).toHaveTextContent('Running the tests')
  })

  it('shows the strip for activity alone, and nothing when there is neither', () => {
    const { container, rerender } = wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        activity={[work('canvas:r', 'canvas', 'working', { to: 'canvas', slug: 'r' })]}
      />,
    )
    expect(screen.getByTestId('activity-chip-canvas:r')).toBeInTheDocument()
    rerender(
      <MantineProvider>
        <SubagentChips
          subagents={[]}
          hidden={new Set()}
          onOpen={() => undefined}
          onClearDone={() => undefined}
        />
      </MantineProvider>,
    )
    expect(container.querySelector('[data-testid=subagent-chips]')).toBeNull()
  })
})
describe('SubagentChips', () => {
  it('Clear done is always there, disabled until a chip is done, and clearing calls back', async () => {
    const user = userEvent.setup()
    const clear = vi.fn()
    const { rerender } = wrap(
      <SubagentChips
        subagents={[sub('b', false)]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={clear}
      />,
    )
    expect(screen.getByTestId('subagent-chip-b')).toHaveAttribute('data-state', 'running')
    expect(screen.getByText('Clear done')).toBeDisabled()
    rerender(
      <MantineProvider>
        <SubagentChips
          subagents={[sub('b', false), sub('a', true)]}
          hidden={new Set()}
          onOpen={() => undefined}
          onClearDone={clear}
        />
      </MantineProvider>,
    )
    expect(screen.getByTestId('subagent-chip-a')).toHaveAttribute('data-state', 'done')
    expect(screen.getByText('Clear done')).toBeEnabled()
    await user.click(screen.getByText('Clear done'))
    expect(clear).toHaveBeenCalled()
  })

  it('a chip whose transcript went quiet for 30 minutes without a result reads as done, not running', () => {
    wrap(
      <SubagentChips
        subagents={[sub('dead', false, '', Date.now() - 31 * 60_000), sub('live', false)]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
      />,
    )
    expect(screen.getByTestId('subagent-chip-dead')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('subagent-chip-live')).toHaveAttribute('data-state', 'running')
    expect(screen.getByText('Clear done')).toBeEnabled()
  })

  it('Clear done sits outside the scrolling chips', () => {
    wrap(
      <SubagentChips
        subagents={[sub('b', false), sub('a', true)]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
      />,
    )
    const clear = screen.getByTestId('subagent-clear-done')
    expect(clear.closest('.eva-chips-scroller')).toBeNull()
    expect(screen.getByTestId('subagent-chip-a').closest('.eva-chips-scroller')).not.toBeNull()
  })

  it('hidden finished chips are left out; Clear done stays, disabled', () => {
    wrap(
      <SubagentChips
        subagents={[sub('b', false), sub('a', true)]}
        hidden={new Set(['a'])}
        onOpen={() => undefined}
        onClearDone={() => undefined}
      />,
    )
    expect(screen.queryByTestId('subagent-chip-a')).toBeNull()
    expect(screen.getByText('Clear done')).toBeDisabled()
  })

  it('clicking a chip opens that subagent and marks the shown one', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const b = sub('b', false, '<b>hi</b>')
    wrap(
      <SubagentChips
        subagents={[b, sub('a', true)]}
        hidden={new Set()}
        active="a"
        onOpen={open}
        onClearDone={() => undefined}
      />,
    )
    await user.click(screen.getByTestId('subagent-chip-b'))
    expect(open).toHaveBeenCalledWith(b, false)
    expect(screen.getByTestId('subagent-chip-a')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('subagent-chip-b')).toHaveAttribute('aria-pressed', 'false')
  })

  it('Cmd+click on a chip asks for a split', async () => {
    const user = userEvent.setup()
    const open = vi.fn()
    const b = sub('b', false)
    wrap(
      <SubagentChips
        subagents={[b]}
        hidden={new Set()}
        onOpen={open}
        onClearDone={() => undefined}
      />,
    )
    await user.keyboard('{Meta>}')
    await user.click(screen.getByTestId('subagent-chip-b'))
    await user.keyboard('{/Meta}')
    expect(open).toHaveBeenCalledWith(b, true)
  })
})

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
  it('stores extras per pane and keeps hiddenDone across updates', () => {
    const s = chatStore.getState()
    s.openPane('pane-1', { file: '/s/x.jsonl', title: 't', messages: [], meta })
    chatStore.getState().setExtras({
      paneId: 'pane-1',
      running: true,
      subagents: [sub('a', true)],
      jobs: [job('1')],
    })
    expect(chatStore.getState().panes['pane-1']!.extras.jobs).toHaveLength(1)
    chatStore.getState().clearDone('pane-1')
    chatStore.getState().setExtras({
      paneId: 'pane-1',
      running: true,
      subagents: [sub('a', true), sub('c', true)],
      jobs: [],
    })
    const hidden = chatStore.getState().hiddenDone
    expect(hidden.has('/s/x.jsonl\0a')).toBe(true)
    expect(hidden.has('/s/x.jsonl\0c')).toBe(false)
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
