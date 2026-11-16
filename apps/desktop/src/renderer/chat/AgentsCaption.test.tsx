import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { makeMessage } from '@evaos/chat-core/message'
import type { AgentRun } from '@relay/protocol'
import { MessageRow, ToolRunRow } from './MessageRow'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../ipc', () => ({ invoke }))

const wrap = (ui: React.ReactElement) => render(<MantineProvider>{ui}</MantineProvider>)

const request = { question: 'Who makes the M5 chip?', depth: 'quick' }
const done: AgentRun = {
  run: 'r1',
  agent: 'web-researcher',
  status: 'done',
  request,
  reply: {
    answer: 'Apple designs the M5.',
    citations: [
      { url: 'https://www.apple.com/newsroom/m5', quote: 'Apple unveils M5', verified: true },
      { url: 'https://en.wikipedia.org/wiki/Apple_M5', quote: 'designed by Apple', verified: true },
    ],
  },
  text: 'Apple designs the M5.',
  seconds: 29.4,
  cost: 0.004,
  sources: 2,
}

afterEach(() => vi.useRealTimers())

describe('AgentsCaption on a chat row', () => {
  it('ticks while a specialist runs on the turn with no reply yet', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const call = makeMessage('c1', 'tool', 'write', {
      tool: { call: 'c1', input: '', result: null, isError: false, status: 'running' },
    })
    const running: AgentRun = {
      agent: 'web-researcher',
      status: 'running',
      request,
      startedAt: Date.now() - 12_000,
    }
    wrap(<MessageRow m={call} agents={[running]} />)
    const caption = screen.getByTestId('agents-caption')
    expect(caption).toHaveAttribute('data-state', 'running')
    expect(screen.getByTestId('msg-c1')).toHaveAttribute('data-agents', 'true')
    expect(within(caption).getByTestId('agents-badge')).toBeInTheDocument()
    expect(caption).toHaveTextContent('Web researcher is on it · 0:12')
    act(() => void vi.advanceTimersByTime(1000))
    expect(caption).toHaveTextContent('Web researcher is on it · 0:13')
  })

  it('shows the done caption under the reply and opens the request, answer and sources', () => {
    const reply = makeMessage('a1', 'assistant', 'Apple makes it.')
    wrap(<MessageRow m={reply} agents={[done]} />)
    const caption = screen.getByTestId('agents-caption')
    expect(caption).toHaveAttribute('data-state', 'done')
    const line = screen.getByTestId('agents-caption-line')
    expect(line).toHaveTextContent('Answered with Web researcher · 29s · 2 sources')
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('agents-details')).toBeNull()

    fireEvent.click(line)
    const details = screen.getByTestId('agents-details')
    expect(line).toHaveAttribute('aria-expanded', 'true')
    expect(details).toHaveTextContent('Who makes the M5 chip?')
    expect(details).toHaveTextContent('29s · $0.004')
    expect(within(details).getByTestId('agents-answer')).toHaveTextContent('Apple designs the M5.')
    const links = within(details).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.apple.com/newsroom/m5',
      'https://en.wikipedia.org/wiki/Apple_M5',
    ])
    expect(links[0]).toHaveTextContent('apple.com/newsroom/m5')
    expect(within(details).getAllByTestId('agents-verified')).toHaveLength(2)
    expect(details).toHaveTextContent('Apple unveils M5')

    fireEvent.click(line)
    expect(screen.queryByTestId('agents-details')).toBeNull()
  })

  it('says a failed run failed and shows its error when opened', () => {
    const failed: AgentRun = {
      agent: 'design-critic',
      status: 'failed',
      error: 'no such agent: design-critic',
    }
    wrap(<MessageRow m={makeMessage('a2', 'assistant', 'I could not ask.')} agents={[failed]} />)
    expect(screen.getByTestId('agents-caption')).toHaveAttribute('data-state', 'failed')
    const line = screen.getByTestId('agents-caption-line')
    expect(line).toHaveTextContent('Design critic failed')
    fireEvent.click(line)
    expect(screen.getByTestId('agents-error')).toHaveTextContent('no such agent: design-critic')
  })

  it('lists several specialists on one line', () => {
    const critic: AgentRun = { run: 'r2', agent: 'design-critic', status: 'done', seconds: 18 }
    wrap(<MessageRow m={makeMessage('a3', 'assistant', 'Both done.')} agents={[done, critic]} />)
    expect(screen.getByTestId('agents-caption-line')).toHaveTextContent(
      'Answered with Web researcher and Design critic · 47s · 2 sources',
    )
  })

  it('a folded run of tool calls carries the caption until a reply does', () => {
    const call = makeMessage('c2', 'tool', 'write', {
      tool: { call: 'c2', input: '', result: null, isError: false, status: 'done' },
    })
    wrap(<ToolRunRow tools={[call]} agents={[done]} />)
    expect(screen.getByTestId('msg-c2-tools')).toHaveAttribute('data-agents', 'true')
    expect(screen.getByTestId('agents-caption-line')).toHaveTextContent(
      'Answered with Web researcher',
    )
  })

  it('shows no caption on a row without runs', () => {
    wrap(<MessageRow m={makeMessage('a4', 'assistant', 'Plain.')} />)
    expect(screen.queryByTestId('agents-caption')).toBeNull()
    expect(screen.getByTestId('msg-a4')).not.toHaveAttribute('data-agents')
  })
})
