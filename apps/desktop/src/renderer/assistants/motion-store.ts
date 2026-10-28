import { useCallback, useSyncExternalStore } from 'react'
import { Director, type MotionSignals, type MotionState } from '@relay/portrait-motion'
import { chatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { assistantsStore } from './assistants-store'
import { onMotionGate, pageHidden } from './motion-gate'
import { motionSignals } from './motion-signals'

/** Edges that come with time alone (Done ending, Snoozing) show within this long. */
const TICK_MS = 1000

/** Agent `id`'s signals now, from the Assistants list and main's chat pane. */
export function agentSignals(id: string): MotionSignals {
  return motionSignals(assistantsStore.getState(), id, chatStore.getState().panes[PANE_ID])
}

interface Entry {
  director: Director
  state: MotionState
  listeners: Set<() => void>
}

/** One director per agent a small portrait shows (crumb, tab, Assistants rows), shared by all of them. */
const entries = new Map<string, Entry>()
let stop: (() => void) | null = null

/**
 * Moves every shown agent's director on. Runs when the stores change and once a second, never
 * while the page is hidden; listeners hear only state changes, so a portrait re-renders on edges.
 */
function tick(): void {
  if (pageHidden()) return
  const now = Date.now()
  for (const [id, e] of entries) {
    const next = e.director.next(agentSignals(id), now)
    if (next === e.state) continue
    e.state = next
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
    const now = Date.now()
    const director = new Director(now)
    e = { director, state: director.next(agentSignals(id), now), listeners: new Set() }
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

/** The state agent `id`'s small portraits show; re-renders only when it changes. */
export function useAgentMotion(id: string): MotionState {
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id])
  return useSyncExternalStore(sub, () => entries.get(id)?.state ?? 'idle')
}
