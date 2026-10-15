import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { BgJob, Subagent } from '@evaos/chat-core/message'
vi.mock('../../ipc', () => ({
  invoke: () => Promise.resolve({ ok: true, value: {} }),
  on: () => () => undefined,
}))

import { chatStore } from '../chat-store'
import { SubagentChips } from './SubagentChips'
import { JobsStrip, elapsed } from './JobsStrip'

const sub = (name: string, done: boolean, lastLine = ''): Subagent => ({
  name,
  file: `${name}.jsonl`,
  done,
  failed: false,
  mtimeMs: 1,
  lastLine,
})
const job = (id: string): BgJob => ({ id, label: `cmd ${id}`, kind: 'bash', startedAt: 1000 })
const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)

describe('SubagentChips', () => {
  it('running chip has no Clear done; a finished chip shows it and clearing calls back', async () => {
    const user = userEvent.setup()
    const clear = vi.fn()
    const { rerender } = wrap(
      <SubagentChips subagents={[sub('b', false)]} hidden={new Set()} onClearDone={clear} />,
    )
    expect(screen.getByTestId('subagent-chip-b')).toHaveAttribute('data-state', 'running')
    expect(screen.queryByText('Clear done')).toBeNull()
    rerender(
      <MantineProvider>
        <SubagentChips
          subagents={[sub('b', false), sub('a', true)]}
          hidden={new Set()}
          onClearDone={clear}
        />
      </MantineProvider>,
    )
    expect(screen.getByTestId('subagent-chip-a')).toHaveAttribute('data-state', 'done')
    await user.click(screen.getByText('Clear done'))
    expect(clear).toHaveBeenCalled()
  })

  it('hidden finished chips are left out and Clear done goes with them', () => {
    wrap(
      <SubagentChips
        subagents={[sub('b', false), sub('a', true)]}
        hidden={new Set(['a'])}
        onClearDone={() => undefined}
      />,
    )
    expect(screen.queryByTestId('subagent-chip-a')).toBeNull()
    expect(screen.queryByText('Clear done')).toBeNull()
  })

  it('clicking a chip shows its last line as text', async () => {
    const user = userEvent.setup()
    wrap(
      <SubagentChips
        subagents={[sub('b', false, '<b>hi</b>')]}
        hidden={new Set()}
        onClearDone={() => undefined}
      />,
    )
    await user.click(screen.getByTestId('subagent-chip-b'))
    expect(await screen.findByTestId('subagent-popover')).toHaveTextContent('<b>hi</b>')
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
