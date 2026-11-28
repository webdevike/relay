import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AgentBoard, AgentColumn } from '@evaos/contract'
import { invoke, on } from '../ipc'
import { bindPref, parseBool } from '../ui-prefs'
import {
  DEFAULT_FILTERS,
  DEFAULT_HIDDEN,
  parseHidden,
  waitingId,
  type BoardFilters,
  type CardWaiting,
} from './board-view'

/**
 * The Board page's state. Main builds every board; this store asks for one when the page
 * mounts, whenever main says a source changed, and on a timer (so gh and Linear, which main
 * refreshes in the background on those asks, keep landing).
 */
export interface AgentsBoardState {
  board: AgentBoard | null
  error: string | null
  /** The card whose side panel is open. */
  selected: string | null
  /** The panel is folded to a strip beside the board; opening a card unfolds it. */
  collapsed: boolean
  filters: BoardFilters
  /** Columns folded into the Hidden columns group, in board order. */
  hidden: AgentColumn[]
  /** Waiting mentions Isaac marked handled here, hidden before the host's next board says so. */
  handled: ReadonlySet<string>
  /** A Refresh was asked: the button rests until then (the host coalesces syncs anyway). */
  syncRestUntil: number
}

export const agentsBoardStore = createStore<AgentsBoardState>(() => ({
  board: null,
  error: null,
  selected: null,
  collapsed: false,
  filters: DEFAULT_FILTERS,
  hidden: [...DEFAULT_HIDDEN],
  handled: new Set(),
  syncRestUntil: 0,
}))

export function useAgentsBoard<T>(selector: (s: AgentsBoardState) => T): T {
  return useStore(agentsBoardStore, selector)
}

const POLL_MS = 30_000
export const SYNC_REST_MS = 30_000

let latest = 0

export async function refreshAgentsBoard(): Promise<void> {
  const ask = ++latest
  const r = await invoke('agents.board', {})
  if (ask !== latest) return
  if (r.ok) agentsBoardStore.setState({ board: r.value, error: null })
  else agentsBoardStore.setState({ error: r.error.message })
}

let watchers = 0
let stop: (() => void) | null = null

/** Follows the board while the page is mounted: now, on every `agents.changed`, and every POLL_MS. */
export function startAgentsBoard(): () => void {
  if (watchers++ === 0) {
    const off = on('agents.changed', () => void refreshAgentsBoard())
    const timer = window.setInterval(() => void refreshAgentsBoard(), POLL_MS)
    stop = () => {
      off()
      window.clearInterval(timer)
    }
    void refreshAgentsBoard()
  }
  return () => {
    if (--watchers === 0) {
      stop?.()
      stop = null
    }
  }
}

export function setBoardFilters(patch: Partial<BoardFilters>): void {
  agentsBoardStore.setState((s) => ({ filters: { ...s.filters, ...patch } }))
}

export function selectCard(id: string | null): void {
  agentsBoardStore.setState({ selected: id, collapsed: false })
}

export function collapsePanel(collapsed: boolean): void {
  agentsBoardStore.setState({ collapsed })
}

export function hideColumn(col: AgentColumn): void {
  agentsBoardStore.setState((s) => ({ hidden: parseHidden([...s.hidden, col]) ?? s.hidden }))
}

export function showColumn(col: AgentColumn): void {
  agentsBoardStore.setState((s) => ({ hidden: s.hidden.filter((c) => c !== col) }))
}

let restTimer: number | undefined

/** Refresh: asks the host to sync now, then rests the button for SYNC_REST_MS. */
export async function syncTickets(): Promise<string | null> {
  if (Date.now() < agentsBoardStore.getState().syncRestUntil) return null
  agentsBoardStore.setState({ syncRestUntil: Date.now() + SYNC_REST_MS })
  window.clearTimeout(restTimer)
  restTimer = window.setTimeout(() => agentsBoardStore.setState({ syncRestUntil: 0 }), SYNC_REST_MS)
  const r = await invoke('tickets.sync', {})
  if (!r.ok) return r.error.message
  return r.value.source === 'host' ? null : r.value.message
}

/**
 * Mark as handled (Relay-only, on the host): every waiting mention on that item up to this one;
 * `undo` brings it back. The chip hides at once; null when the host took it, else why not.
 */
export async function setWaitingHandled(w: CardWaiting, undo: boolean): Promise<string | null> {
  const id = waitingId(w)
  const mark = (on: boolean): void =>
    agentsBoardStore.setState((s) => {
      const handled = new Set(s.handled)
      if (on) handled.add(id)
      else handled.delete(id)
      return { handled }
    })
  mark(!undo)
  const r = await invoke('tickets.handled', {
    target: {
      kind: 'mention',
      provider: w.provider,
      itemId: w.itemId,
      throughCommentId: w.commentId,
    },
    undo,
  })
  const error = !r.ok ? r.error.message : r.value.source === 'host' ? null : r.value.message
  if (error !== null) mark(undo)
  else void refreshAgentsBoard()
  return error
}

// The panel fold and the hidden columns are the user's choices: kept in layout.json. The search
// words and the waiting toggle are a moment's question and start empty.
bindPref(agentsBoardStore, 'agents.collapsed', {
  select: (s) => s.collapsed,
  apply: (collapsed) => ({ collapsed }),
  parse: parseBool,
})
bindPref<AgentsBoardState, AgentColumn[]>(agentsBoardStore, 'agents.hiddenColumns', {
  select: (s) => s.hidden,
  apply: (hidden) => ({ hidden }),
  parse: parseHidden,
  same: (a, b) => a.length === b.length && a.every((c, i) => c === b[i]),
})
