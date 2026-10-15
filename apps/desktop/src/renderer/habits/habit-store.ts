import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { GateStatus, InvokeInput } from '@evaos/contract'
import { invoke } from '../ipc'
import { registerReloader } from '../reload/reload'

export const POLL_MS = 4000

export interface HabitState {
  status: GateStatus | null
  error: string | null
  stale: boolean
  busy: boolean
  generation: number
  loadedOnce: boolean
}

const initial = (): HabitState => ({
  status: null,
  error: null,
  stale: false,
  busy: false,
  generation: 0,
  loadedOnce: false,
})

export const habitStore = createStore<HabitState>(initial)

export function useHabits<T>(selector: (s: HabitState) => T): T {
  return useStore(habitStore, selector)
}

export type HabitAction = InvokeInput<'habit.run'>

let inflight: { generation: number; promise: Promise<void> } | null = null

/** One read at a time; a read older than the newest command, or started while busy, is dropped. */
export function pollHabits(): Promise<void> {
  const s = habitStore.getState()
  if (s.busy) return Promise.resolve()
  if (inflight && inflight.generation === s.generation) return inflight.promise
  const generation = s.generation
  const promise = (async () => {
    let r
    try {
      r = await invoke('habit.status', {})
    } catch {
      r = null
    }
    const now = habitStore.getState()
    if (now.busy || now.generation !== generation) return
    if (r?.ok) {
      habitStore.setState({ status: r.value, error: null, stale: false, loadedOnce: true })
    } else if (now.status) {
      habitStore.setState({ stale: true })
    } else {
      habitStore.setState({
        error: r && !r.ok ? r.error.message : 'The habit gate did not answer.',
        loadedOnce: true,
      })
    }
  })().finally(() => {
    if (inflight?.promise === promise) inflight = null
  })
  inflight = { generation, promise }
  return promise
}

const firstLine = (text: string): string => text.trim().split('\n')[0] || 'no details'

/** Runs one CLI command; its reply carries the new status, so no re-poll is needed. */
export async function runHabit(
  action: HabitAction,
): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  habitStore.setState((s) => ({ busy: true, generation: s.generation + 1 }))
  let r
  try {
    r = await invoke('habit.run', action)
  } catch {
    r = null
  }
  if (r?.ok) {
    habitStore.setState((s) => ({
      status: r.value,
      error: null,
      stale: false,
      loadedOnce: true,
      busy: false,
      generation: s.generation + 1,
    }))
    return { ok: true }
  }
  habitStore.setState((s) => ({ busy: false, generation: s.generation + 1 }))
  return {
    ok: false,
    message: firstLine(r && !r.ok ? r.error.message : 'The habit gate did not answer.'),
    ...(r && !r.ok ? { code: r.error.code } : {}),
  }
}

let started: (() => void) | null = null

/** Idempotent. Polls now, every 4 s while visible, on becoming visible, and on every reload. */
export function startHabits(): () => void {
  if (started) return started
  const tick = (): void => {
    if (!document.hidden) void pollHabits()
  }
  const timer = setInterval(tick, POLL_MS)
  document.addEventListener('visibilitychange', tick)
  const off = registerReloader('habits', pollHabits)
  void pollHabits()
  const dispose = (): void => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', tick)
    off()
    started = null
  }
  started = dispose
  return dispose
}

export function resetHabitsForTests(): void {
  started?.()
  inflight = null
  habitStore.setState(initial(), true)
}
