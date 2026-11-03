import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ContextQuery, ContextScope, ContextSnapshot, PinRef } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { agentIdOf, assistantsStore } from '../assistants/assistants-store'
import { activePlace, tabsStore } from '../tabs/tabs-store'

/**
 * The context popover's state. Main composes every snapshot; this store asks for one when the
 * place in front changes, when main says something changed, and on a timer (main's gh and git
 * caches refresh in the background on those asks, sooner while the popover is open).
 */
export interface ContextState {
  snapshot: ContextSnapshot | null
  open: boolean
  scope: ContextScope
}

export const contextStore = createStore<ContextState>(() => ({
  snapshot: null,
  open: false,
  scope: 'here',
}))

export function useContextStore<T>(selector: (s: ContextState) => T): T {
  return useStore(contextStore, selector)
}

const OPEN_POLL_MS = 10_000
const CLOSED_POLL_MS = 60_000

/** What "here" is for `place`: the chat's session file, or the assistant whose thread it is. */
export function queryFor(place: Place, scope: ContextScope, open: boolean): ContextQuery {
  const agent = agentIdOf(place)
  const file =
    agent === null && place.page === 'chat' && place.chat !== null && place.chat.endsWith('.jsonl')
      ? place.chat
      : null
  return { file, agent, scope, open }
}

/** The newest ask; an older one answers with its result, since the place may have moved on. */
let latest: Promise<ContextSnapshot | null> = Promise.resolve(null)

/** Asks main for a snapshot of what is in front now; null only when the newest ask failed. */
export async function refreshContext(): Promise<ContextSnapshot | null> {
  const { scope, open } = contextStore.getState()
  const ask = invoke('context.get', queryFor(activePlace(tabsStore.getState()), scope, open)).then(
    (r) => {
      if (ask !== latest) return null
      if (r.ok) contextStore.setState({ snapshot: r.value })
      return r.ok ? r.value : null
    },
  )
  latest = ask
  // A newer ask started while this one ran: wait for it, its answer is the one that counts.
  for (let waiting: Promise<ContextSnapshot | null> = ask; ; waiting = latest) {
    const value = await waiting
    if (waiting === latest) return value
  }
}

export function setContextOpen(open: boolean): void {
  if (contextStore.getState().open === open) return
  contextStore.setState({ open })
  if (open) void refreshContext()
}

export function setContextScope(scope: ContextScope): void {
  contextStore.setState({ scope })
  void refreshContext()
}

export async function pinContext(ref: PinRef): Promise<void> {
  const r = await invoke('context.pin', { ref })
  if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code })
  await refreshContext()
}

export async function unpinContext(id: string): Promise<void> {
  const r = await invoke('context.unpin', { id })
  if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code })
  await refreshContext()
}

/** Idempotent per call pair: subscribes, asks once, polls; the returned function stops it all. */
export function startContext(): () => void {
  let last = JSON.stringify(queryFor(activePlace(tabsStore.getState()), 'here', false))
  const offTabs = tabsStore.subscribe((s) => {
    const next = JSON.stringify(queryFor(activePlace(s), 'here', false))
    if (next === last) return
    last = next
    // A new place starts on its own context; the popover closes with the old one.
    contextStore.setState({ scope: 'here', open: false })
    void refreshContext()
  })
  // An assistant's thread appears (its first reply) or changes status.
  const offAssistants = assistantsStore.subscribe(() => void refreshContext())
  const offChanged = on('context.changed', () => void refreshContext())
  let timer: number | undefined
  const schedule = (): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(
      () => {
        void refreshContext().finally(schedule)
      },
      contextStore.getState().open ? OPEN_POLL_MS : CLOSED_POLL_MS,
    )
  }
  const offOpen = contextStore.subscribe((s, prev) => {
    if (s.open !== prev.open) schedule()
  })
  void refreshContext()
  schedule()
  return () => {
    offTabs()
    offAssistants()
    offChanged()
    offOpen()
    window.clearTimeout(timer)
  }
}
