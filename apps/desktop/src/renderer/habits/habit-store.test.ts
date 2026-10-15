import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { reloadPages, resetReloadForTests } from '../reload/reload'
import { habitStore, pollHabits, resetHabitsForTests, runHabit, startHabits } from './habit-store'

const status = (id: string) => ({ locked: false, habits: [{ id }], tasks: [], history: [] })
const okStatus = (id: string) => ({ ok: true, value: status(id) })

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  resetHabitsForTests()
  resetReloadForTests()
})
afterEach(() => {
  resetHabitsForTests()
  vi.useRealTimers()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('habit polling', () => {
  it('polls now, every 4 s while visible, pauses hidden, resumes visible, disposes', async () => {
    invoke.mockResolvedValue(okStatus('a'))
    const stop = startHabits()
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(invoke).toHaveBeenCalledTimes(2)
    setHidden(true)
    await vi.advanceTimersByTimeAsync(12000)
    expect(invoke).toHaveBeenCalledTimes(2)
    setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledTimes(3)
    await reloadPages()
    expect(invoke).toHaveBeenCalledTimes(4)
    stop()
    await vi.advanceTimersByTimeAsync(12000)
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('drops a poll older than a command and any poll started while busy', async () => {
    let releasePoll!: (v: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((r) => (releasePoll = r)))
    const p = pollHabits()
    const gen0 = habitStore.getState().generation
    let releaseRun!: (v: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((r) => (releaseRun = r)))
    const run = runHabit({ action: 'habit-rm', id: 'x' })
    expect(habitStore.getState().busy).toBe(true)
    expect(habitStore.getState().generation).toBeGreaterThan(gen0)
    await pollHabits() // busy: no invoke
    expect(invoke).toHaveBeenCalledTimes(2)
    releaseRun(okStatus('new'))
    await expect(run).resolves.toEqual({ ok: true })
    releasePoll(okStatus('old'))
    await p
    expect(habitStore.getState().status?.habits[0].id).toBe('new')
    expect(habitStore.getState().busy).toBe(false)
    expect(habitStore.getState().generation).toBeGreaterThanOrEqual(gen0 + 2)
  })

  it('reports the first error line of a failed command', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'gate-error', message: 'bad\nmore' } })
    await expect(runHabit({ action: 'habit-rm', id: 'x' })).resolves.toEqual({
      ok: false,
      message: 'bad',
    })
    expect(habitStore.getState().busy).toBe(false)
  })

  it('marks stale with prior data, errors without, and a success clears both', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'gate-error', message: 'down' } })
    await pollHabits()
    expect(habitStore.getState()).toMatchObject({ status: null, error: 'down', stale: false })
    invoke.mockResolvedValueOnce(okStatus('a'))
    await pollHabits()
    expect(habitStore.getState()).toMatchObject({ error: null, stale: false, loadedOnce: true })
    invoke.mockRejectedValueOnce(new Error('x'))
    await pollHabits()
    expect(habitStore.getState().stale).toBe(true)
    expect(habitStore.getState().status).not.toBeNull()
    invoke.mockResolvedValueOnce(okStatus('b'))
    await pollHabits()
    expect(habitStore.getState()).toMatchObject({ stale: false, error: null })
  })
})
