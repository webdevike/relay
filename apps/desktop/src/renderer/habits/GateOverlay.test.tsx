import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { overlayStore } from '../overlay/overlay-store'
import { dispatchChord, registerAction } from '../hotkeys/router'
import { GateOverlay } from './GateOverlay'
import { habitStore, resetHabitsForTests } from './habit-store'

const NOW = new Date(2026, 9, 15, 12, 0, 0)

function status(over: Record<string, unknown> = {}) {
  return {
    locked: true,
    lockedAt: NOW.toISOString(),
    reason: 'Break due',
    active: null,
    plan: null,
    history: [],
    habits: [
      { id: 'stretch', name: 'Stretch', minutes: 10, photo: false },
      { id: 'walk', name: 'Walk', minutes: 20, photo: true },
    ],
    tasks: [{ id: 'taxes', name: 'Taxes', minutes: 30, done: false }],
    canFinish: false,
    remainingSeconds: 0,
    blocked: false,
    ...over,
  }
}
const activeIn = (id: string, seconds: number, total = 600) => ({
  kind: 'habit',
  id,
  startedAt: new Date(Date.now() - (total - seconds) * 1000).toISOString(),
  endsAt: new Date(Date.now() + seconds * 1000).toISOString(),
})

function mount() {
  return render(
    <MantineProvider>
      <GateOverlay />
    </MantineProvider>,
  )
}
const seed = (s: unknown) => act(() => habitStore.setState({ status: s as never }))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  resetHabitsForTests()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GateOverlay', () => {
  it('renders only while locked, occludes the browser and locks chords, and cleans up', () => {
    const r = mount()
    expect(screen.queryByTestId('gate-overlay')).toBeNull()
    seed(status({ locked: false }))
    expect(screen.queryByTestId('gate-overlay')).toBeNull()
    seed(status())
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Time for a break' })).toBeTruthy()
    expect(dlg.getAttribute('aria-labelledby')).toBe(screen.getByRole('heading').id)
    expect(screen.getByText("Eva's AI tools are locked until you finish a habit.")).toBeTruthy()
    expect(overlayStore.getState().ids.size).toBe(1)
    const ran = vi.fn()
    const off = registerAction('new-tab', ran)
    expect(dispatchChord('cmd+t', { fromGuest: false })).toBe(true)
    expect(ran).not.toHaveBeenCalled()
    seed(status({ locked: false }))
    expect(overlayStore.getState().ids.size).toBe(0)
    dispatchChord('cmd+t', { fromGuest: false })
    expect(ran).toHaveBeenCalledTimes(1)
    off()
    r.unmount()
  })

  it('lists habits and tasks, moves with arrows and starts the selection', () => {
    mount()
    seed(status())
    expect(screen.getByTestId('gate-pick-stretch').textContent).toContain('10 min')
    expect(screen.getByTestId('gate-pick-stretch').textContent).toContain('Honor')
    expect(screen.getByTestId('gate-pick-walk').textContent).toContain('Photo')
    expect(screen.getByTestId('gate-pick-taxes').textContent).toContain('Task, 30 min')
    expect(screen.getByTestId('gate-pick-stretch').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('gate-start'))
    fireEvent.keyDown(screen.getByTestId('gate-pick-stretch'), { key: 'ArrowDown' })
    expect(screen.getByTestId('gate-pick-walk').getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByTestId('gate-start'))
    expect(invoke).toHaveBeenCalledWith('habit.run', { action: 'start', id: 'walk' })
  })

  it('counts down in m:ss and h:mm:ss, enables done at the end', () => {
    mount()
    seed(status({ active: activeIn('stretch', 65) }))
    expect(screen.getByTestId('gate-countdown').textContent).toBe('1:05')
    expect((screen.getByTestId('gate-done') as HTMLButtonElement).disabled).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByTestId('gate-countdown').textContent).toBe('1:04')
    act(() => {
      vi.advanceTimersByTime(64_000)
    })
    expect(screen.getByText("Time's up. Mark break done to unlock.")).toBeTruthy()
    expect((screen.getByTestId('gate-done') as HTMLButtonElement).disabled).toBe(false)
    seed(status({ active: activeIn('stretch', 3725, 3725) }))
    expect(screen.getByTestId('gate-countdown').textContent).toBe('1:02:05')
  })

  it('needs a photo for photo habits and sends its token', async () => {
    invoke.mockImplementation(async (ch: string) =>
      ch === 'habit.choosePhoto'
        ? { ok: true, value: { token: 'tok', name: 'p.png' } }
        : { ok: true, value: status({ locked: false }) },
    )
    mount()
    seed(status({ active: activeIn('walk', 0) }))
    const done = screen.getByTestId('gate-done') as HTMLButtonElement
    expect(done.disabled).toBe(true)
    expect(screen.getByText('Photo proof required')).toBeTruthy()
    expect(screen.getByTestId('gate-photo').textContent).toContain('Choose photo')
    fireEvent.click(screen.getByTestId('gate-photo'))
    await waitFor(() => expect(screen.getByTestId('gate-photo-name').textContent).toBe('p.png'))
    expect(screen.getByTestId('gate-photo').textContent).toContain('Change photo')
    expect(done.disabled).toBe(false)
    fireEvent.click(done)
    expect(invoke).toHaveBeenCalledWith('habit.run', {
      action: 'done',
      id: 'walk',
      photoToken: 'tok',
    })
  })

  it('validates the override reason and runs override', () => {
    mount()
    seed(status())
    fireEvent.click(screen.getByTestId('gate-override'))
    expect(screen.getByText('Why skip this break?', { selector: 'label' })).toBeTruthy()
    const box = screen.getByTestId('gate-override-reason')
    fireEvent.change(box, { target: { value: 'ab' } })
    expect(screen.getByText('Give a reason to override.')).toBeTruthy()
    expect((screen.getByTestId('gate-override-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByText('Keep gate locked'))
    expect(screen.queryByTestId('gate-override-reason')).toBeNull()
    fireEvent.click(screen.getByTestId('gate-override'))
    fireEvent.change(screen.getByTestId('gate-override-reason'), {
      target: { value: ' too tired ' },
    })
    fireEvent.click(screen.getByTestId('gate-override-submit'))
    expect(invoke).toHaveBeenCalledWith('habit.run', { action: 'override', reason: 'too tired' })
  })

  it('shows a failed action as an alert', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'gate-error', message: 'boom\nmore' } })
    mount()
    seed(status())
    fireEvent.click(screen.getByTestId('gate-start'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      'Could not update the gate. The habit gate said: boom. Try again.',
    )
  })

  it('ignores Escape and keeps Tab inside', () => {
    mount()
    seed(status())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByTestId('gate-overlay')).toBeTruthy()
    const override = screen.getByTestId('gate-override')
    override.focus()
    fireEvent.keyDown(override, { key: 'Tab' })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(override)
  })
})
