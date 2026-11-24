import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MantineProvider } from '@mantine/core'
import type { OpenAsk } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import type { Dialog } from '@evaos/chat-core/message'

const invoke = vi.fn(async (..._a: unknown[]) => ({ ok: true, value: { sent: true } }))
vi.mock('../../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => undefined,
}))

import { answerAsk } from '../asks/asks-store'
import { CardStack, type CardStackProps } from './CardStack'
import { stackCards, type StackSources } from './stack-cards'

const NOW = Date.now()

const ask = (id: string, over: Partial<OpenAsk> = {}): OpenAsk => ({
  id,
  source: 'replies',
  label: `Ask ${id}`,
  question: `Which way for ${id}?`,
  replies: ['Left', 'Right'],
  at: 1,
  ...over,
})
const run = (id: string, over: Partial<ActivityItem> = {}): ActivityItem => ({
  id,
  kind: 'session',
  owner: 'assistant:nova',
  title: 'Workshop look on rigged Guardian',
  status: 'working',
  intent: 'Comparing shot 4 against the reference frame',
  startedAt: NOW - 35 * 60_000 - 12_000,
  updatedAt: NOW,
  open: { to: 'chat', thread: `session:${id}`, session: id },
  ...over,
})
const cardsOf = (over: Partial<StackSources>) =>
  stackCards({
    dialog: null,
    asks: [],
    subagents: [],
    sessionFile: '/s/c.jsonl',
    activity: [],
    spunOff: [],
    now: NOW,
    ...over,
  })

const props = (over: Partial<CardStackProps> = {}): CardStackProps => ({
  paneId: 'pane-1',
  cards: [],
  onAnswerAsk: vi.fn(),
  onDismissAsk: vi.fn(),
  onOpenRun: vi.fn(),
  ...over,
})
const show = (p: CardStackProps) =>
  render(
    <MantineProvider>
      <CardStack {...p} />
    </MantineProvider>,
  )

beforeEach(() => {
  invoke.mockClear()
  // The app's motion setting off: every move settles at once.
  document.documentElement.dataset['evaMotion'] = 'off'
})
afterEach(() => {
  delete document.documentElement.dataset['evaMotion']
})

describe('CardStack', () => {
  it('shows no tab without cards', () => {
    show(props())
    expect(screen.queryByTestId('card-stack')).toBeNull()
  })

  it('collapsed, the tab names the front card with no count, and a sliver shows the next one', () => {
    show(props({ cards: cardsOf({ asks: [ask('aaaaaaaa'), ask('bbbbbbbb', { at: 2 })] }) }))
    const tab = screen.getByTestId('card-stack-tab')
    expect(tab).toHaveTextContent('Ask aaaaaaaa')
    expect(screen.getByTestId('card-stack')).not.toHaveTextContent(/\bof\b|\d+ \/ \d+/)
    expect(screen.getByTestId('card-stack-peek')).toBeInTheDocument()
    expect(screen.getByTestId('card-stack-dismiss')).toHaveAccessibleName('Dismiss this decision')
  })

  it('open, the header holds the title and only Collapse; dots step, the active one wider', async () => {
    const user = userEvent.setup()
    show(props({ cards: cardsOf({ asks: [ask('aaaaaaaa'), ask('bbbbbbbb', { at: 2 })] }) }))
    await user.click(screen.getByTestId('card-stack-tab'))
    expect(screen.getByTestId('card-stack')).toHaveAttribute('data-state', 'expanded')
    const head = screen.getByTestId('card-stack-title').parentElement!
    expect(head).toHaveTextContent('Ask aaaaaaaa')
    expect(
      within(head)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Collapse'])
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /next|previous/i })).toBeNull()
    const dots = screen.getAllByTestId('card-stack-dot')
    expect(dots.map((d) => d.dataset['on'])).toEqual(['true', 'false'])
    expect(getComputedStyle(dots[0]!).width).toBe('16px')
    expect(getComputedStyle(dots[1]!).width).toBe('6px')
    await user.click(dots[1]!)
    expect(screen.getByTestId('card-stack-title')).toHaveTextContent('Ask bbbbbbbb')
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.getByTestId('card-stack-title')).toHaveTextContent('Ask aaaaaaaa'),
    )
    await user.click(screen.getByTestId('card-stack-collapse'))
    expect(screen.getByTestId('card-stack')).toHaveAttribute('data-state', 'collapsed')
  })

  it('a click outside the open card collapses it', async () => {
    const user = userEvent.setup()
    show(props({ cards: cardsOf({ asks: [ask('aaaaaaaa')] }) }))
    await user.click(screen.getByTestId('card-stack-tab'))
    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('card-stack')).toHaveAttribute('data-state', 'collapsed')
  })

  it('a running card shows its clock, logo and model, its recent work, and Open session', async () => {
    const user = userEvent.setup()
    const onOpenRun = vi.fn()
    const item = run('w1', {
      model: 'Claude Opus 5.5',
      vendor: 'anthropic',
      thinking: 'high',
      log: [
        'Imported the rigged Guardian into the workshop scene',
        'Matched the key light to the Tiny Glade reference',
        'Comparing shot 4 against the reference frame',
      ],
    })
    show(props({ cards: cardsOf({ spunOff: [item] }), onOpenRun }))
    // Collapsed: the title and a quiet Open session link, no peek for a lone card.
    expect(screen.getByTestId('card-stack-tab')).toHaveTextContent(item.title)
    expect(screen.getByTestId('card-stack-open-link')).toHaveTextContent('Open session')
    expect(screen.queryByTestId('card-stack-peek')).toBeNull()
    await user.click(screen.getByTestId('card-stack-tab'))
    expect(screen.getByTestId('card-stack-timer').textContent).toMatch(/^35m 1\ds$/)
    expect(screen.getByTestId('card-stack-model')).toHaveTextContent('Opus 5.5 high')
    expect(
      screen.getByTestId('card-stack-model').querySelector('img[data-vendor="anthropic"]'),
    ).not.toBeNull()
    const log = screen.getByTestId('card-stack-log')
    expect([...log.children].map((l) => l.textContent)).toEqual(item.log)
    expect(screen.queryByRole('progressbar')).toBeNull()
    await user.click(screen.getByTestId('card-stack-open-session'))
    expect(onOpenRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run:w1' }), false)
  })

  it('a running card from an older host shows its intent alone, and no logo without a vendor', async () => {
    const user = userEvent.setup()
    show(props({ cards: cardsOf({ spunOff: [run('w1')] }) }))
    await user.click(screen.getByTestId('card-stack-tab'))
    expect(screen.queryByTestId('card-stack-model')).toBeNull()
    expect(screen.getByTestId('card-stack-log')).toHaveTextContent(
      'Comparing shot 4 against the reference frame',
    )
  })

  it("answering a replies ask sends Isaac's turn and resolves it on the host", async () => {
    const user = userEvent.setup()
    const send = vi.fn()
    const replies = ask('aaaaaaaa')
    const session = ask('bbbbbbbb', { source: 'session', at: 2 })
    show(
      props({
        cards: cardsOf({ asks: [replies, session] }),
        onAnswerAsk: (a, reply) => void answerAsk('nova', a, reply, send),
      }),
    )
    await user.click(screen.getByTestId('card-stack-tab'))
    expect(screen.getByText('Which way for aaaaaaaa?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Right' }))
    expect(send).toHaveBeenCalledWith('[answer to: "Which way for aaaaaaaa?"] Right')
    expect(invoke).toHaveBeenCalledWith('asks.resolve', {
      agent: 'nova',
      id: 'aaaaaaaa',
      how: 'answered',
      answer: 'Right',
    })
    // A session's ask only resolves: the host hands the answer to the asking session.
    send.mockClear()
    await user.click(screen.getAllByTestId('card-stack-dot')[1]!)
    await user.type(screen.getByRole('textbox', { name: 'Or type an answer' }), 'Neither{Enter}')
    expect(send).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('asks.resolve', {
      agent: 'nova',
      id: 'bbbbbbbb',
      how: 'answered',
      answer: 'Neither',
    })
  })

  it('an ask with no replies takes a typed answer', async () => {
    const user = userEvent.setup()
    const onAnswerAsk = vi.fn()
    show(props({ cards: cardsOf({ asks: [ask('aaaaaaaa', { replies: [] })] }), onAnswerAsk }))
    await user.click(screen.getByTestId('card-stack-tab'))
    const send = screen.getByRole('button', { name: 'Send answer' })
    expect(send).toBeDisabled()
    await user.type(screen.getByRole('textbox', { name: 'Your answer' }), 'Battery life')
    await user.click(send)
    expect(onAnswerAsk).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aaaaaaaa' }),
      'Battery life',
    )
  })

  it("the session's new question opens the stack on it and answers through chat.answerUi", async () => {
    const user = userEvent.setup()
    const select: Dialog = {
      kind: 'select',
      id: 'u2',
      title: 'Pick one',
      options: [{ label: 'A' }, { label: 'B' }],
    }
    show(props({ cards: cardsOf({ dialog: select, spunOff: [run('w1')] }) }))
    expect(screen.getByTestId('card-stack')).toHaveAttribute('data-state', 'expanded')
    expect(screen.getByTestId('card-stack-title')).toHaveTextContent('Pick one')
    await user.click(screen.getByRole('radio', { name: /B/ }))
    expect(invoke).toHaveBeenCalledWith('chat.answerUi', {
      paneId: 'pane-1',
      id: 'u2',
      response: { kind: 'select', value: 'B' },
    })
  })
})
