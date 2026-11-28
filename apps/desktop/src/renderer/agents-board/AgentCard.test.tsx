import { MantineProvider } from '@mantine/core'
import { DndContext } from '@dnd-kit/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

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

  it('a nested chip click opens its own target, never the card under it', async () => {
    const onOpen = vi.fn()
    ui(onOpen)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('agents-wait-open'))
    await user.click(screen.getByTestId('agents-pr-12'))
    // Each nested chip opened once (the side panel for now); the card's own click never ran.
    expect(onOpen).toHaveBeenCalledTimes(2)
    await user.click(screen.getByTestId('agents-card-ENG-1'))
    expect(onOpen).toHaveBeenCalledTimes(3)
  })

  it('Enter on the card opens it', async () => {
    const onOpen = vi.fn()
    ui(onOpen)
    screen.getByTestId('agents-card-ENG-1').focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
