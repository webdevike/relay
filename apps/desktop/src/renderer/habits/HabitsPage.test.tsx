import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import { placeOf } from '@evaos/shell-core'
import { resetReloadForTests } from '../reload/reload'
import { HabitsPage } from './HabitsPage'
import { habitStore, pollHabits, resetHabitsForTests } from './habit-store'

const NOW = new Date(2026, 9, 15, 12, 0, 0)
const at = (days: number, h: number, m: number): string =>
  new Date(2026, 9, 15 - days, h, m).toISOString()

function seed(over: Record<string, unknown> = {}) {
  return {
    locked: false,
    lockedAt: null,
    reason: null,
    active: null,
    plan: {
      date: '2026-10-15',
      breaks: [
        { at: at(0, 10, 0), done: true },
        { at: at(0, 11, 0), done: false },
        { at: at(0, 23, 30), done: false },
      ],
      source: 'calendar',
    },
    history: [
      {
        kind: 'habit',
        id: 'stretch',
        name: 'Stretch',
        startedAt: at(1, 10, 0),
        doneAt: at(1, 10, 10),
        photo: null,
        override: null,
      },
      {
        kind: 'habit',
        id: 'stretch',
        name: 'Stretch',
        startedAt: at(0, 10, 0),
        doneAt: at(0, 10, 10),
        photo: null,
        override: null,
      },
      {
        kind: 'habit',
        id: 'walk',
        name: 'Walk',
        startedAt: at(0, 9, 0),
        doneAt: at(0, 9, 20),
        photo: '/p/walk-proof.png',
        override: null,
      },
      {
        kind: 'override',
        id: '',
        name: 'Override',
        startedAt: null,
        doneAt: at(1, 15, 0),
        photo: null,
        override: 'Meeting ran long',
      },
    ],
    habits: [
      { id: 'stretch', name: 'Stretch', minutes: 10, photo: false },
      { id: 'walk', name: 'Walk', minutes: 20, photo: true },
    ],
    tasks: [{ id: 'taxes', name: 'Do taxes', minutes: 30, done: false }],
    canFinish: false,
    remainingSeconds: 0,
    blocked: false,
    ...over,
  }
}

function ui() {
  return render(
    <MantineProvider>
      <HabitsPage place={placeOf('habits')} />
    </MantineProvider>,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  invoke.mockReset()
  show.mockReset()
  resetHabitsForTests()
  resetReloadForTests()
  invoke.mockImplementation(async (channel: string) =>
    channel === 'habit.status' ? { ok: true, value: seed() } : { ok: true, value: seed() },
  )
})
afterEach(() => vi.useRealTimers())

describe('HabitsPage', () => {
  it('shows the gate KPIs, plan source and the stale line', async () => {
    ui()
    const strip = await screen.findByTestId('habit-gate-strip')
    expect(strip).toHaveAttribute('data-locked', 'false')
    expect(screen.getByTestId('habit-gate')).toHaveTextContent('Unlocked')
    expect(screen.getByTestId('habit-next-break')).toHaveTextContent('11:30 PM')
    // Two numbers stay visible; the rest is read off the info icon.
    expect(strip).not.toHaveTextContent('1 of 3')
    const more = screen.getByTestId('list-kpis-more').getAttribute('aria-label')
    expect(more).toContain('Breaks today: 1 of 3')
    expect(more).toContain('From your calendar')
    expect(more).toContain('Best streak')
    expect(screen.queryByTestId('habits-stale')).toBeNull()
    act(() => habitStore.setState({ stale: true }))
    expect(screen.getByText('Showing the last status. Retrying.')).toBeInTheDocument()
    act(() => habitStore.setState({ status: seed({ locked: true }) as never }))
    expect(screen.getByTestId('habit-gate-strip')).toHaveAttribute('data-locked', 'true')
    expect(screen.getByTestId('habit-gate')).toHaveTextContent(
      'LockedFinish a habit to unlock AI tools',
    )
  })

  it('renders habits, tasks, breaks and history with overrides and photos', async () => {
    ui()
    const stretch = await screen.findByTestId('habit-row-stretch')
    expect(stretch).toHaveTextContent('Stretch')
    expect(stretch).toHaveTextContent('2 days')
    expect(stretch).toHaveAttribute('title', 'Stretch\n10 min · Honor system')
    expect(stretch).not.toHaveTextContent('Honor')
    expect(screen.getByTestId('habit-row-walk').getAttribute('title')).toContain('Photo proof')
    const task = screen.getByTestId('task-row-taxes')
    expect(within(task).getByRole('button', { name: 'Remove task' })).toBeInTheDocument()
    const breaks = screen.getByTestId('breaks-today')
    expect(within(breaks).getByText('Done')).toBeInTheDocument()
    expect(within(breaks).getByText('Due')).toBeInTheDocument()
    expect(within(breaks).getByText('Upcoming')).toBeInTheDocument()
    const today = screen.getByTestId('history-day-Today')
    expect(within(today).getByText('Done today')).toBeInTheDocument()
    const yesterday = screen.getByTestId('history-day-Yesterday')
    expect(within(yesterday).getByText('Done yesterday')).toBeInTheDocument()
    // The finish note is on hover, not on the row.
    expect(yesterday.querySelector('[title*="Overridden: Meeting ran long"]')).not.toBeNull()
    expect(within(yesterday).queryByText('Overridden: Meeting ran long')).toBeNull()
    fireEvent.click(within(today).getByTestId('history-photo'))
    expect(invoke).toHaveBeenCalledWith('habit.openPhoto', { path: '/p/walk-proof.png' })
  })

  it('shows a retry card when the first read fails', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'gate-error', message: 'nope' } })
    ui()
    expect(await screen.findByText('Could not read the habit gate')).toBeInTheDocument()
    invoke.mockResolvedValue({ ok: true, value: seed() })
    fireEvent.click(screen.getByTestId('habits-retry'))
    expect(await screen.findByTestId('habit-gate-strip')).toBeInTheDocument()
  })

  it('validates and saves a new habit, then toasts', async () => {
    ui()
    await screen.findByTestId('habit-row-stretch')
    fireEvent.click(screen.getByTestId('habits-add'))
    const body = await screen.findByTestId('habit-form-body')
    expect(screen.getByText('New habit')).toBeInTheDocument()
    expect(within(body).getByPlaceholderText('Stretch')).toBeInTheDocument()
    expect(within(body).getByText('Ask for a photo when this break is done')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('habit-save'))
    expect(await screen.findByText('Give the habit a name.')).toBeInTheDocument()
    expect(screen.getByText('Minutes must be a whole number from 1 to 600.')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith('habit.run', expect.anything())
    fireEvent.change(screen.getByTestId('habit-name'), { target: { value: 'Read' } })
    fireEvent.change(screen.getByTestId('habit-minutes'), { target: { value: '15' } })
    fireEvent.click(screen.getByTestId('habit-save'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('habit.run', {
        action: 'habit-add',
        name: 'Read',
        minutes: 15,
        photo: false,
      }),
    )
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Saved Read.' })),
    )
  })

  it('edits with photo false explicitly, removes through the inline confirm, shows CLI failures', async () => {
    ui()
    fireEvent.click(await screen.findByTestId('habit-row-walk'))
    await screen.findByTestId('habit-form-body')
    fireEvent.click(screen.getByTestId('habit-photo'))
    fireEvent.click(screen.getByTestId('habit-save'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('habit.run', {
        action: 'habit-edit',
        id: 'walk',
        name: 'Walk',
        minutes: 20,
        photo: false,
      }),
    )
    fireEvent.click(await screen.findByTestId('habit-row-walk'))
    fireEvent.click(await screen.findByTestId('habit-remove'))
    expect(screen.getByText('Remove Walk? Its history stays.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('habit-remove-confirm'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('habit.run', { action: 'habit-rm', id: 'walk' }),
    )

    invoke.mockResolvedValue({
      ok: false,
      error: { code: 'gate-error', message: 'simulated failure\ndetails' },
    })
    fireEvent.click(await screen.findByTestId('habits-add'))
    fireEvent.change(await screen.findByTestId('habit-name'), { target: { value: 'Z' } })
    fireEvent.change(screen.getByTestId('habit-minutes'), { target: { value: '5' } })
    fireEvent.click(screen.getByTestId('habit-save'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Could not save the habit change. The habit gate said: simulated failure. Fix it and try again.',
    )
  })

  it('adds and removes tasks', async () => {
    ui()
    await screen.findByTestId('task-row-taxes')
    fireEvent.click(screen.getByTestId('task-add'))
    expect(await screen.findByText('Say what the task is.')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('task-name'), { target: { value: 'File receipts' } })
    fireEvent.change(screen.getByTestId('task-minutes'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByTestId('task-add'))
    expect(
      await screen.findByText('Minutes must be a whole number from 1 to 600.'),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('task-minutes'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('task-add'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('habit.run', {
        action: 'task-add',
        name: 'File receipts',
        minutes: null,
      }),
    )
    fireEvent.click(
      within(screen.getByTestId('task-row-taxes')).getByRole('button', { name: 'Remove task' }),
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('habit.run', { action: 'task-rm', id: 'taxes' }),
    )
  })

  it('polls on mount', async () => {
    ui()
    await screen.findByTestId('habit-gate-strip')
    expect(invoke).toHaveBeenCalledWith('habit.status', {})
    await pollHabits()
  })
})
