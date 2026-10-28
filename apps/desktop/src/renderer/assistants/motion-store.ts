import { useCallback, useSyncExternalStore } from 'react'
import {
  Director,
  STATE_META,
  statusDot,
  type DotTone,
  type MotionSignals,
  type MotionState,
} from '@relay/portrait-motion'
import { chatStore } from '../chat/chat-store'
import { PANE_ID } from '../chat/open-chat'
import { assistantsStore } from './assistants-store'
import { onMotionGate, pageHidden } from './motion-gate'
import { motionSignals } from './motion-signals'

/** Edges that come with time alone (Waking ending, Snoozing) show within this long. */
const TICK_MS = 1000

/** What a portrait shows: its face and its status dot. */
export interface PortraitView {
  state: MotionState
  dot: DotTone
}

export const IDLE_VIEW: PortraitView = { state: 'idle', dot: null }

/** The dot's words: needing Isaac and failing are said by the dot alone, else the face's status. */
export function dotLabel(view: PortraitView): string {
  if (view.dot === 'orange') return 'Needs you'
  if (view.dot === 'red') return 'Something went wrong'
  return STATE_META[view.state].status
}

/** Agent `id`'s signals now, from the Assistants list and main's chat pane. */
export function agentSignals(id: string): MotionSignals {
  return motionSignals(assistantsStore.getState(), id, chatStore.getState().panes[PANE_ID])
}

/** The director's view for `signals` at `now`: the same object while nothing changed. */
export function nextView(
  director: Director,
  signals: MotionSignals,
  now: number,
  was: PortraitView,
): PortraitView {
  const state = director.next(signals, now)
  const dot = statusDot(signals)
  return state === was.state && dot === was.dot ? was : { state, dot }
}

interface Entry {
  director: Director
  view: PortraitView
  listeners: Set<() => void>
}

/** One director per agent a small portrait shows (crumb, tab, Assistants rows), shared by all of them. */
const entries = new Map<string, Entry>()
let stop: (() => void) | null = null

/**
 * Moves every shown agent's director on. Runs when the stores change and once a second, never
 * while the page is hidden; listeners hear only view changes, so a portrait re-renders on edges.
 */
function tick(): void {
  if (pageHidden()) return
  const now = Date.now()
  for (const [id, e] of entries) {
    const next = nextView(e.director, agentSignals(id), now, e.view)
    if (next === e.view) continue
    e.view = next
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
    e = {
      director,
      view: nextView(director, agentSignals(id), Date.now(), IDLE_VIEW),
      listeners: new Set(),
    }
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

/** The face and dot agent `id`'s small portraits show; re-renders only when either changes. */
export function useAgentMotion(id: string): PortraitView {
  const sub = useCallback((cb: () => void) => subscribe(id, cb), [id])
  return useSyncExternalStore(sub, () => entries.get(id)?.view ?? IDLE_VIEW)
}
