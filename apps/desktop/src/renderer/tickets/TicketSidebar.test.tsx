import { MantineProvider } from '@mantine/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearState, LinearTicket } from '@evaos/contract'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { TicketSidebar } from './TicketSidebar'
import { fromLinearTicket, type TicketData, type WriteMode } from './ticket-data'
import { parseTicketPlace } from './ticket-place'

const LEGACY: LinearTicket = {
  id: 'issue-1',
  key: 'ENG-1',
  title: 'Fix the thing',
  url: 'https://linear.app/acme/issue/ENG-1',
  description: '',
  creator: 'Chris Doe',
  createdAt: 1,
  updatedAt: 2,
  state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
  assignee: null,
  priority: 'High',
  labels: [],
  project: null,
  team: 'Engineering',
  parent: null,
  children: [],
  links: [
    { title: 'PR', url: 'https://github.com/acme/app/pull/12', kind: 'github' },
    { title: 'Design doc', url: 'https://example.test/doc', kind: 'link' },
    { title: 'c1', url: 'https://github.com/acme/app/commit/abc123', kind: 'github' },
  ],
  comments: [],
  people: [],
  me: { name: 'Isaac Weber', handle: 'isaac', url: 'https://linear.app/acme/profiles/isaac' },
}

const STATES: LinearState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', color: '#ccc', position: 0 },
  { id: 's-prog', name: 'In Progress', type: 'started', color: '#f2c94c', position: 1 },
  { id: 's-review', name: 'In Review', type: 'started', color: '#0f0', position: 2 },
  { id: 's-done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 3 },
]

const refresh = vi.fn()

const dataOf = (writeMode: WriteMode): TicketData => ({
  key: 'ENG-1',
  detail: fromLinearTicket(LEGACY),
  source: 'fallback',
  unavailable: null,
  writeMode,
  me: { linearViewerId: null, name: 'Isaac Weber' },
  legacy: LEGACY,
  refresh,
})

function view(writeMode: WriteMode) {
  render(
    <MantineProvider>
      <TicketSidebar
        at={parseTicketPlace('ticket:ENG-1')!}
        data={dataOf(writeMode)}
        card={null}
        prs={[]}
        go={vi.fn()}
      />
    </MantineProvider>,
  )
}

function answer(setState: () => unknown = () => ({ ok: true, value: STATES[2] })): void {
  invoke.mockImplementation((channel: string) => {
    if (channel === 'reviews.linearStates') return Promise.resolve({ ok: true, value: STATES })
    if (channel === 'reviews.linearSetState') return Promise.resolve(setState())
    return Promise.resolve({ ok: true, value: null })
  })
}

const writes = () => invoke.mock.calls.filter(([c]) => c === 'reviews.linearSetState')

async function pick(name: string): Promise<void> {
  await userEvent.click(screen.getByTestId('ticket-status'))
  await userEvent.click(await screen.findByTestId(`ticket-state-${name}`, {}, { timeout: 5_000 }))
}

afterEach(() => {
  invoke.mockReset()
  refresh.mockReset()
})

describe('the sidebar without host sync (legacy)', () => {
  it("changes the status through Reviews' own write, as the old panel did", async () => {
    answer()
    view('legacy')
    expect(screen.getByTestId('ticket-status').dataset.write).toBe('legacy')
    await pick('In Review')
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(writes()).toEqual([
      ['reviews.linearSetState', { issueId: 'issue-1', stateId: 's-review' }],
    ])
    // Nothing went near the host's gate.
    expect(invoke.mock.calls.some(([c]) => String(c).startsWith('tickets.'))).toBe(false)
  })

  it('asks before Done, and Cancel writes nothing', async () => {
    answer(() => ({ ok: true, value: STATES[3] }))
    view('legacy')
    await pick('Done')
    expect(await screen.findByText('Move ENG-1 to Done?')).toBeTruthy()
    expect(writes()).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(writes()).toHaveLength(0)
    await pick('Done')
    await userEvent.click(await screen.findByTestId('ticket-status-confirm-ok'))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0]![1]).toEqual({ issueId: 'issue-1', stateId: 's-done' })
  })

  it("stays a label where the statuses can't be read (a thin client)", async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'thin-client', message: 'Use the Mini' } })
    view('legacy')
    await userEvent.click(screen.getByTestId('ticket-status'))
    await waitFor(() => expect(screen.getByTestId('ticket-status').tagName).toBe('DIV'))
    expect(writes()).toHaveLength(0)
  })

  it("shows the read's other links and linked commits, as Reviews' rail did", () => {
    view('legacy')
    const link = screen.getByTestId('ticket-link')
    expect(link.textContent).toBe('Design doc')
    expect(link.getAttribute('title')).toBe('https://example.test/doc')
    expect(screen.getByTestId('ticket-commits').textContent).toBe('1 linked commit')
  })

  it('is a plain label when no write path is open', () => {
    view('none')
    expect(screen.getByTestId('ticket-status').tagName).toBe('DIV')
    expect(screen.getByTestId('ticket-status').textContent).toBe('In Progress')
  })
})
