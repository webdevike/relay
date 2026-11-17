import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import type { SpecialistRun } from '@evaos/contract'
import type { AgentRun } from '@relay/protocol'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../ipc', () => ({ invoke, on: () => () => undefined }))

import { SubagentChips } from './SubagentChips'
import { chatServiceRuns, chatSpecialists } from './specialist-runs'

const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)
const strip = (specialists: AgentRun[], onClearDone = () => undefined) => (
  <MantineProvider>
    <SubagentChips
      subagents={[]}
      hidden={new Set()}
      onOpen={() => undefined}
      onClearDone={onClearDone}
      specialists={specialists}
    />
  </MantineProvider>
)

const NOW = 1_800_000_000_000
const asked: AgentRun = {
  agent: 'web-researcher',
  run: 'r1',
  status: 'running',
  request: { question: 'Who makes the M5 chip?' },
  startedAt: NOW - 12_000,
}

afterEach(() => {
  vi.useRealTimers()
  invoke.mockReset()
})

describe('a specialist badge in the chat strip', () => {
  it('runs with a ticking clock, then reads done with how long it took, or failed', () => {
    vi.useFakeTimers({ now: NOW })
    const clear = vi.fn()
    const { rerender } = render(strip([asked], clear))
    const chip = screen.getByTestId('specialist-chip-r1')
    expect(chip).toHaveAttribute('data-kind', 'specialist')
    expect(chip).toHaveAttribute('data-state', 'running')
    expect(chip).toHaveTextContent('Web researcher0:12')
    expect(screen.getByText('Clear done')).toBeDisabled()
    act(() => void vi.advanceTimersByTime(1000))
    expect(chip).toHaveTextContent('Web researcher0:13')

    rerender(strip([{ ...asked, status: 'done', seconds: 29.4 }], clear))
    expect(screen.getByTestId('specialist-chip-r1')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('specialist-chip-r1')).toHaveTextContent('Web researcher29s')
    expect(screen.getByText('Clear done')).toBeEnabled()
    fireEvent.click(screen.getByText('Clear done'))
    expect(clear).toHaveBeenCalled()

    rerender(strip([{ ...asked, status: 'failed', error: 'timed out' }], clear))
    expect(screen.getByTestId('specialist-chip-r1')).toHaveAttribute('data-state', 'failed')
    expect(screen.getByTestId('specialist-chip-r1')).toHaveTextContent(/^Web researcher$/)
  })

  it('a click shows what was asked and the answer', async () => {
    wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        specialists={[{ ...asked, status: 'done', seconds: 29, text: 'Apple designs the M5.' }]}
      />,
    )
    fireEvent.click(screen.getByTestId('specialist-chip-r1'))
    const details = await screen.findByTestId('specialist-details-r1')
    expect(details).toHaveTextContent('Who makes the M5 chip?')
    expect(details).toHaveTextContent('Apple designs the M5.')
    expect(invoke).not.toHaveBeenCalledWith('agents.specialistRun', expect.anything())
  })

  it('a run that ended with no reply in the chat reads its reply from the service when opened', async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        text: JSON.stringify({
          agent: 'web-researcher',
          run: 'r1',
          status: 'done',
          text: 'From the service.',
        }),
      },
    })
    wrap(
      <SubagentChips
        subagents={[]}
        hidden={new Set()}
        onOpen={() => undefined}
        onClearDone={() => undefined}
        specialists={[{ agent: 'web-researcher', run: 'r1', status: 'done', seconds: 64 }]}
      />,
    )
    fireEvent.click(screen.getByTestId('specialist-chip-r1'))
    expect(await screen.findByText('From the service.')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('agents.specialistRun', { run: 'r1' })
  })
})

describe("a chat's specialist badges", () => {
  const call = (id: string, agent: AgentRun) =>
    makeMessage(id, 'tool', 'write', {
      tool: { call: id, input: '', result: null, isError: false, status: 'running' },
      agent,
    })
  const service = (
    run: string,
    caller: SpecialistRun['caller'],
    status: SpecialistRun['status'],
  ): SpecialistRun => ({
    run,
    agent: 'web-researcher',
    caller,
    status,
    summary: null,
    job: null,
    error: null,
    model: null,
    at: NOW - 12_000,
    seconds: status === 'running' ? null : 64,
    cost: null,
  })

  it('the service finishes an ask that came back running; runs another chat asked stay out', () => {
    const messages = [makeMessage('u1', 'user', 'look it up'), call('c1', asked)]
    const runs = [
      service('r1', { kind: 'chat', file: '/s/this.jsonl', title: null }, 'done'),
      service('r2', { kind: 'chat', file: '/s/other.jsonl', title: null }, 'running'),
      service('r3', { kind: 'assistant', id: 'penny' }, 'running'),
    ]
    const badges = chatSpecialists(messages, chatServiceRuns(runs, '/s/this.jsonl', null), NOW)
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({
      run: 'r1',
      status: 'done',
      seconds: 64,
      request: asked.request,
    })
  })

  it("an assistant's thread shows the runs it asked as that assistant", () => {
    const runs = [service('r3', { kind: 'assistant', id: 'nova' }, 'running')]
    expect(chatServiceRuns(runs, '/s/nova.jsonl', 'nova').map((r) => r.run)).toEqual(['r3'])
    expect(chatServiceRuns(runs, '/s/nova.jsonl', null)).toEqual([])
  })

  it('a badge the transcript left running reads what the service recorded, whoever asked it', () => {
    const left: AgentRun = {
      agent: 'prop-render',
      run: 'r-left',
      status: 'running',
      startedAt: NOW - 20_000,
    }
    const messages = [makeMessage('u1', 'user', 'render'), call('c1', left)]
    const finished = service(
      'r-left',
      { kind: 'chat', file: '/s/other.jsonl', title: null },
      'done',
    )
    expect(chatSpecialists(messages, [], NOW, [finished])[0]).toMatchObject({
      run: 'r-left',
      status: 'done',
    })
    // Before the service was read at all, the transcript stands; a service that lacks the run fails it.
    expect(chatSpecialists(messages, [], NOW, null)[0]?.status).toBe('running')
    expect(chatSpecialists(messages, [], NOW, [])[0]?.status).toBe('failed')
  })

  it("a trial shows the caller's run and the other arms as lettered badges; a switch names the new model", () => {
    const nova = { kind: 'assistant', id: 'nova' } as const
    const own: AgentRun = {
      agent: 'diagram',
      run: 'req-1',
      status: 'running',
      startedAt: NOW - 5000,
    }
    const messages = [makeMessage('u1', 'user', 'draw it'), call('c1', own)]
    const runs: SpecialistRun[] = [
      { ...service('req-1', nova, 'running'), agent: 'diagram', trial: 'B' },
      { ...service('t1:A', nova, 'running'), agent: 'diagram', trial: 'A' },
      { ...service('t1:C', nova, 'done'), agent: 'diagram', trial: 'C' },
      { ...service('r9', nova, 'running'), agent: 'web-researcher', newModel: 'Sonnet 5.5' },
    ]
    const badges = chatSpecialists(messages, chatServiceRuns(runs, '', 'nova'), NOW, runs)
    const shown = badges.map((b) => [b.run, b.trial, b.newModel])
    expect(shown.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ['r9', undefined, 'Sonnet 5.5'],
      ['req-1', 'B', undefined],
      ['t1:A', 'A', undefined],
      ['t1:C', 'C', undefined],
    ])
    wrap(strip(badges))
    expect(screen.getByTestId('specialist-chip-req-1')).toHaveTextContent('Diagram B')
    expect(screen.getByTestId('specialist-chip-t1:A')).toHaveTextContent('Diagram A')
    expect(screen.getByTestId('specialist-chip-t1:C')).toHaveTextContent('Diagram C')
    expect(screen.getByTestId('specialist-chip-r9')).toHaveTextContent(
      'Web researcher · Sonnet 5.5',
    )
  })
})
