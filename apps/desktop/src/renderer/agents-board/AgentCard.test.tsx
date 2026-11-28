import { MantineProvider } from '@mantine/core'
import { DndContext } from '@dnd-kit/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Place } from '@evaos/shell-core'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const openPlace = vi.fn<(p: Place) => void>()
vi.mock('../navigation/navigate', () => ({ openPlace: (p: Place) => openPlace(p) }))

import { AgentCardView, useCardSensors } from './AgentCard'
import { agentsBoardStore } from './agents-store'
import { NOW, cardOf, ticketOf, waitingFrom } from './test-cards'

const card = cardOf({
  key: 'ENG-1',
  ticket: ticketOf({
    waiting: waitingFrom('Chris Doe'),
    prs: [
      {
        repo: 'acme/app',
        number: 12,
        url: 'https://github.com/acme/app/pull/12',
        title: 'Fix it',
        state: 'open',
        checks: 'pass',
        decision: null,
      },
    ],
  }),
})

/** The board's own drag sensor, so a press that doesn't move stays a click. */
function Board({ onOpen }: { onOpen: () => void }) {
  return (
    <DndContext sensors={useCardSensors()}>
      <AgentCardView card={card} now={NOW} active={false} onOpen={onOpen} />
    </DndContext>
  )
}

function ui(onOpen: () => void) {
  return render(
    <MantineProvider>
      <Board onOpen={onOpen} />
    </MantineProvider>,
  )
}

afterEach(() => {
  invoke.mockReset()
  openPlace.mockReset()
  agentsBoardStore.setState({ handled: new Set() })
})

describe('board card', () => {
  it('Mark as handled is reached by Tab and fires on Enter without opening the card', async () => {
    invoke.mockResolvedValue({ ok: true, value: { source: 'host' } })
    const onOpen = vi.fn()
    ui(onOpen)
    const user = userEvent.setup()
    const handled = screen.getByRole('button', { name: 'Mark as handled' })
    // Card, then the waiting chip, then its check.
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('agents-card-ENG-1'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('agents-wait-open'))
    await user.tab()
    expect(document.activeElement).toBe(handled)
    await user.keyboard('{Enter}')
    expect(invoke).toHaveBeenCalledWith('tickets.handled', {
      target: { kind: 'mention', provider: 'linear', itemId: 'ENG-1', throughCommentId: 'c-1' },
      undo: false,
    })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('Space on the check works too, and the chip hides at once', async () => {
    invoke.mockResolvedValue({ ok: true, value: { source: 'host' } })
    const onOpen = vi.fn()
    ui(onOpen)
    screen.getByRole('button', { name: 'Mark as handled' }).focus()
    await userEvent.setup().keyboard(' ')
    expect(invoke.mock.calls.filter(([c]) => c === 'tickets.handled')).toHaveLength(1)
    expect(screen.queryByTestId('agents-wait')).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('a nested chip opens its own place, never the card under it', async () => {
    const onOpen = vi.fn()
    ui(onOpen)
    const user = userEvent.setup()
    // The waiting chip opens the comment on the ticket's page; the PR chip that PR's page.
    await user.click(screen.getByTestId('agents-wait-open'))
    await user.click(screen.getByTestId('agents-pr-12'))
    expect(openPlace.mock.calls.map(([p]) => p.page)).toEqual([
      'ticket:ENG-1#comment-c-1',
      'ticket:ENG-1/pr/acme/app/12',
    ])
    expect(onOpen).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('agents-card-ENG-1'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('Enter on the card opens it', async () => {
    const onOpen = vi.fn()
    ui(onOpen)
    screen.getByTestId('agents-card-ENG-1').focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('agent work keeps its stage pill (fallback has no ticket facts); a pure ticket has none', () => {
    const view = (c: typeof card) =>
      render(
        <MantineProvider>
          <DndContext>
            <AgentCardView card={c} now={NOW} active={false} onOpen={() => {}} />
          </DndContext>
        </MantineProvider>,
      )
    // The fallback board: a ledger item with no synced ticket.
    const stuck = cardOf({
      key: 'ENG-2',
      pill: { label: 'QA bounced', tone: 'danger' },
      reason: 'Bounced back from QA; needs a fix pass',
    })
    view(stuck)
    const pill = screen.getByTestId('agents-card-pill')
    expect(pill.textContent).toBe('QA bounced')
    expect(pill.querySelector('[data-tone="bad"]')).not.toBeNull()
    view({ ...stuck, id: 'ticket:ENG-3', key: 'ENG-3', kind: 'ticket', ticket: ticketOf() })
    expect(screen.getAllByTestId('agents-card-pill')).toHaveLength(1)
  })
})
