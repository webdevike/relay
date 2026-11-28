import type { ReactNode } from 'react'
import { MantineProvider } from '@mantine/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TicketDetail } from '@relay/protocol'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const shown: { message: ReactNode }[] = []
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (n: { message: ReactNode }) => shown.push(n), hide: () => {} },
}))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({ openPlace: (p: unknown) => openPlace(p) }))
const replace = vi.fn()
vi.mock('../pages/place-host', () => ({ useReplacePlace: () => replace }))
vi.mock('./ticket-place', () => ({
  ticketPlace: (key: string, o?: { pr?: { number: number } | null; comment?: string | null }) =>
    `ticket:${key}${o?.pr ? `/pr/${o.pr.number}` : ''}${o?.comment ? `#comment-${o.comment}` : ''}`,
}))

import { SummaryCard } from './SummaryCard'
import type { TicketData } from './ticket-data'

const pal = { id: 'user-pal', name: 'Sample Teammate', avatarUrl: null }
const detail = {
  key: 'ENG-1',
  updatedAt: Date.now() - 3_600_000,
  prFacts: [],
  comments: [],
  attention: {
    waiting: [
      {
        provider: 'linear',
        itemId: 'ENG-1',
        rootId: 'c-2',
        commentId: 'c-2',
        author: pal,
        at: Date.now() - 3_600_000,
        excerpt: 'Can you look?',
        count: 1,
        anchor: { kind: 'comment' },
      },
    ],
    needsYou: {
      kind: 'merge',
      text: 'Merge PR #12.',
      action: { kind: 'openPr', label: 'Open PR #12', pr: { repo: 'acme/app', number: 12 } },
      evidence: 'sha:APPROVED',
    },
  },
} as unknown as TicketDetail

const dataOf = (over: Partial<TicketData> = {}): TicketData => ({
  key: 'ENG-1',
  detail,
  source: 'host',
  unavailable: null,
  writeMode: 'gate',
  me: { linearViewerId: 'user-me', name: 'Isaac' },
  refresh: vi.fn(),
  ...over,
})

type Answer = { ok: true; value: unknown } | { ok: false; error: { message: string } }
function answer(summary: Answer | Promise<Answer>): void {
  invoke.mockImplementation((channel: string) => {
    if (channel === 'tickets.summary') return summary
    if (channel === 'tickets.seen')
      return Promise.resolve({ ok: true, value: { source: 'host', previousSeenAt: null } })
    return Promise.resolve({ ok: true, value: { source: 'host' } })
  })
}

const view = (data: TicketData) =>
  render(
    <MantineProvider>
      <SummaryCard data={data} card={null} />
    </MantineProvider>,
  )

const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel)

afterEach(() => {
  invoke.mockReset()
  openPlace.mockReset()
  replace.mockReset()
  shown.length = 0
})

describe('SummaryCard', () => {
  it('shows a skeleton while the summary loads, then the text', async () => {
    // The desktop lib predates Promise.withResolvers.
    let done: (a: Answer) => void = () => {}
    answer(new Promise<Answer>((r) => (done = r)))
    view(dataOf())
    expect(screen.getByTestId('ticket-summary-loading')).toBeTruthy()
    done({
      ok: true,
      value: { source: 'host', summary: { key: 'ENG-1', text: 'It works.', at: 1 } },
    })
    expect((await screen.findByTestId('ticket-summary-text')).textContent).toBe('It works.')
    expect(calls('tickets.seen')).toHaveLength(1)
  })

  it('on error shows Summary unavailable and the facts footer, never text', async () => {
    answer(Promise.resolve({ ok: false, error: { message: 'boom' } }))
    view(dataOf())
    expect(await screen.findByText('Summary unavailable')).toBeTruthy()
    expect(screen.queryByTestId('ticket-summary-text')).toBeNull()
    expect(screen.getByTestId('ticket-summary-footer').textContent).toContain('Updated 1h ago')
  })

  it('fallback mode makes no summary or seen call and shows facts only', () => {
    answer(Promise.resolve({ ok: false, error: { message: 'x' } }))
    view(dataOf({ source: 'fallback' }))
    expect(calls('tickets.summary')).toHaveLength(0)
    expect(calls('tickets.seen')).toHaveLength(0)
    expect(screen.queryByTestId('ticket-summary-loading')).toBeNull()
    expect(screen.getByTestId('ticket-summary-footer').textContent).toContain('Updated')
  })

  it('asks seen once per visit across re-renders', async () => {
    answer(Promise.resolve({ ok: false, error: { message: 'x' } }))
    const data = dataOf()
    const r = view(data)
    r.rerender(
      <MantineProvider>
        <SummaryCard data={{ ...data, detail: { ...detail, updatedAt: 5 } }} card={null} />
      </MantineProvider>,
    )
    await waitFor(() => expect(calls('tickets.summary').length).toBeGreaterThan(1))
    expect(calls('tickets.seen')).toHaveLength(1)
  })

  it('waiting: Tab-reachable clear control sends a mention handled, Undo reverses it', async () => {
    answer(Promise.resolve({ ok: false, error: { message: 'x' } }))
    const user = userEvent.setup()
    view(dataOf())
    const clear = screen.getAllByRole('button', { name: 'Mark as handled' })[0]!
    while (document.activeElement !== clear) await user.tab()
    await user.keyboard('{Enter}')
    const target = { kind: 'mention', provider: 'linear', itemId: 'ENG-1', throughCommentId: 'c-2' }
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tickets.handled', { target, undo: false }),
    )
    expect(screen.queryByTestId('ticket-summary-waiting')).toBeNull()
    render(<MantineProvider>{shown.at(-1)!.message}</MantineProvider>)
    await user.click(screen.getByTestId('ticket-handled-undo'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tickets.handled', { target, undo: true }),
    )
    expect(screen.getByTestId('ticket-summary-waiting')).toBeTruthy()
    // Relay-only: nothing reaches a provider write path.
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(calls('tickets.commit')).toHaveLength(0)
  })

  it('needs you: clear control sends needs handled with evidence; action opens the PR', async () => {
    answer(Promise.resolve({ ok: false, error: { message: 'x' } }))
    const user = userEvent.setup()
    view(dataOf())
    await user.click(screen.getByTestId('ticket-summary-needs-action'))
    expect(openPlace).toHaveBeenCalledWith('ticket:ENG-1/pr/12')
    await user.click(screen.getByTestId('ticket-summary-needs-handled'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('tickets.handled', {
        target: { kind: 'needs', itemId: 'ENG-1', reasonKind: 'merge', evidence: 'sha:APPROVED' },
        undo: false,
      }),
    )
    expect(calls('tickets.prepare')).toHaveLength(0)
    expect(calls('tickets.commit')).toHaveLength(0)
  })

  it('waiting line click focuses the comment through the place hash', async () => {
    answer(Promise.resolve({ ok: false, error: { message: 'x' } }))
    view(dataOf())
    await userEvent.click(screen.getByText(/is waiting on your reply/))
    expect(replace).toHaveBeenCalledWith('ticket:ENG-1#comment-c-2')
  })
})
