import { useCallback, useSyncExternalStore } from 'react'
import { Director, type MotionSignals, type MotionState } from '@relay/portrait-motion'
import { chatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { assistantsStore } from './assistants-store'
import { onMotionGate, pageHidden } from './motion-gate'
import { motionSignals } from './motion-signals'

/** Edges that come with time alone (Waking ending, Snoozing) show within this long. */
const TICK_MS = 1000

/** Signals laid over agents' real ones: a test seam (e2e's `portraitSignals` hook) only. */
const overrides = new Map<string, Partial<MotionSignals>>()

/** Lays `patch` over agent `id`'s signals until called again with null (e2e only). */
export function overrideSignals(id: string, patch: Partial<MotionSignals> | null): void {
  if (patch === null) overrides.delete(id)
  else overrides.set(id, patch)
  tick()
}

/** Agent `id`'s signals now, from the Assistants list and main's chat pane. */
export function agentSignals(id: string): MotionSignals {
  const real = motionSignals(assistantsStore.getState(), id, chatStore.getState().panes[PANE_ID])
  const patch = overrides.get(id)
  return patch === undefined ? real : { ...real, ...patch }
}

// Mirrors @relay/portrait-motion's `statusText` (the phone's header line) until the package
// exports it; swap this for the import then.
const STATUS_TEXT: Partial<Record<MotionState, string>> = {
  thinking: 'is thinking',
  researching: 'is researching',
  working: 'is working',
  snoozing: 'is away',
}

/** The short words after an agent's name: needing Isaac and failing first, else its face's. */
export function statusText(state: MotionState, s: MotionSignals): string | null {
  if (s.waiting) return 'needs you'
  if (s.failed) return 'hit a snag'
  return STATUS_TEXT[state] ?? null
}

interface Entry {
  director: Director
  state: MotionState
  /** `statusText` for the state and the signals it came from. */
  text: string | null
  listeners: Set<() => void>
}

/** One director per agent a small portrait or crumb shows, shared by all of them. */
const entries = new Map<string, Entry>()
let stop: (() => void) | null = null

/**
 * Moves every shown agent's director on. Runs when the stores change and once a second, never
 * while the page is hidden; listeners hear only face or text changes, so they re-render on edges.
 */
function tick(): void {
  if (pageHidden()) return
  const now = Date.now()
  for (const [id, e] of entries) {
    const s = agentSignals(id)
    const state = e.director.next(s, now)
    const text = statusText(state, s)
    if (state === e.state && text === e.text) continue
    e.state = state
    e.text = text
    for (const l of e.listeners) l()
  }
}

function start(): () => void {
  let timer: number | undefined
  const schedule = (): void => {
    if (pageHidden()) {
      clearInterval(timer)
      timer = undefined
    } else timer ??= window.setInterval(tick, TICK_MS)
  }
  const offAssistants = assistantsStore.subscribe(tick)
  const offChat = chatStore.subscribe(tick)
  const offGate = onMotionGate(() => {
    schedule()
    tick()
  })
  schedule()
  return () => {
    offAssistants()
    offChat()
    offGate()
    clearInterval(timer)
  }
}

function subscribe(id: string, cb: () => void): () => void {
  let e = entries.get(id)
  if (e === undefined) {
    const director = new Director()
    const s = agentSignals(id)
    const state = director.next(s, Date.now())
    e = { director, state, text: statusText(state, s), listeners: new Set() }
    entries.set(id, e)
  }
  e.listeners.add(cb)
  stop ??= start()
  return () => {
    e.listeners.delete(cb)
    if (e.listeners.size === 0) entries.delete(id)
    if (entries.size === 0 && stop) {
      stop()
      stop = null
    }
  }
}

/** The face agent `id`'s small portraits show; re-renders only when it changes. */
export function useAgentMotion(id: string): MotionState {
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id])
  return useSyncExternalStore(sub, () => entries.get(id)?.state ?? 'idle')
}

/** The words after agent `id`'s name in its crumb (`statusText`), null when it has none. */
export function useAgentStatus(id: string): string | null {
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id])
  return useSyncExternalStore(sub, () => entries.get(id)?.text ?? null)
}
