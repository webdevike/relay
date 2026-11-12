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

const MIN = 60_000
const etaOf = (elapsedMin: number, over: Partial<NonNullable<ActivityItem['eta']>> = {}) => ({
  from: Date.now() - elapsedMin * MIN,
  totalMs: 20 * MIN,
  lowMs: 15 * MIN,
  highMs: 30 * MIN,
  typicalMs: 18 * MIN,
  runs: 34,
  confidence: 'confident' as const,
  overrunning: false,
  ...over,
})

describe('SubagentChips progress fill', () => {
  const session = (id: string, eta?: ActivityItem['eta']): ActivityItem => ({
    ...work(`session:${id}`, 'session', 'working', {
      to: 'chat',
      thread: `session:${id}`,
      session: id,
    }),
    ...(eta === undefined ? {} : { eta }),
  })
  const chips = (
    activity: ActivityItem[],
    extra: Partial<Parameters<typeof SubagentChips>[0]> = {},
  ) => (
    <MantineProvider>
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        activity={activity}
        {...extra}
      />
    </MantineProvider>
  )

  it('a badge with an estimate fills by how far along it is and says the time left; one without draws as before', () => {
    wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        agentColor="#3366ff"
        activity={[session('sure', etaOf(10)), session('none')]}
      />,
    )
    const sure = screen.getByTestId('activity-chip-session:sure')
    expect(sure).toHaveAttribute('data-eta', 'solid')
    expect(sure).toHaveClass('eva-eta')
    expect(Number(sure.style.getPropertyValue('--eta-fraction'))).toBeCloseTo(0.5, 1)
    expect(sure.style.getPropertyValue('--eva-eta-agent-c')).toBe('#3366ff')
    expect(sure.querySelector('[data-testid="eta-short"]')).toHaveTextContent('10m')
    const none = screen.getByTestId('activity-chip-session:none')
    expect(none).not.toHaveAttribute('data-eta')
    expect(none).not.toHaveClass('eva-eta')
    expect(none.querySelector('[data-testid="eta-short"]')).toBeNull()
  })

  it('a rough guess is striped, and a run past its usual time is amber with no time text', () => {
    wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        activity={[session('rough', etaOf(5, { confidence: 'rough' })), session('late', etaOf(45))]}
      />,
    )
    expect(screen.getByTestId('activity-chip-session:rough')).toHaveAttribute('data-eta', 'striped')
    const late = screen.getByTestId('activity-chip-session:late')
    expect(late).toHaveAttribute('data-eta', 'overrunning')
    expect(late.querySelector('[data-testid="eta-short"]')).toBeNull()
  })

  it('the hover adds what is left and how sure the estimate is', async () => {
    const user = userEvent.setup()
    wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        activity={[session('tip', etaOf(10, { runs: 3 }))]}
      />,
    )
    await user.hover(screen.getByTestId('activity-chip-session:tip'))
    const tip = await screen.findByTestId('eta-tip-session:tip')
    expect(tip).toHaveTextContent('About 10 min left')
    expect(tip).toHaveTextContent('Fairly sure · 3 similar runs')
  })

  it("a helper chip finds its run by its transcript's path in the host's list", () => {
    const mine = {
      ...work('helper:/s/chat1/b.jsonl', 'helper', 'working', {
        to: 'subagent',
        file: '/s/chat1/b.jsonl',
        name: 'b',
      }),
      eta: etaOf(5, { confidence: 'rough' }),
    }
    const other = {
      ...work('helper:/s/chat1/other.jsonl', 'helper', 'working', {
        to: 'subagent',
        file: '/s/chat1/other.jsonl',
        name: 'o',
      }),
      eta: etaOf(5),
    }
    wrap(
      <SubagentChips
        subagents={[sub('b', false), sub('c', false)]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        sessionFile="/s/chat1.jsonl"
        helperActivity={[mine, other]}
      />,
    )
    const b = screen.getByTestId('subagent-chip-b')
    expect(b).toHaveAttribute('data-eta', 'striped')
    expect(b.querySelector('[data-testid="eta-short"]')).toHaveTextContent('15m')
    // Another file's estimate is not this one's, and a helper with none draws as before.
    expect(screen.getByTestId('subagent-chip-c')).not.toHaveAttribute('data-eta')
  })

  it('a finished run fills up and fades out of the strip instead of vanishing', () => {
    vi.useFakeTimers()
    try {
      const run = session('fin', etaOf(10))
      const { rerender } = render(chips([run]))
      expect(screen.getByTestId('activity-chip-session:fin')).not.toHaveAttribute(
        'data-eta-leaving',
      )
      rerender(chips([]))
      const leaving = screen.getByTestId('activity-chip-session:fin')
      expect(leaving).toHaveAttribute('data-eta-leaving', 'chip')
      expect(leaving.style.getPropertyValue('--eta-fraction')).toBe('1')
      act(() => {
        vi.advanceTimersByTime(1_500)
      })
      expect(screen.queryByTestId('activity-chip-session:fin')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
