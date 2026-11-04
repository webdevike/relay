import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { PresenceAgent, PresenceFocus, PresenceRange } from '@evaos/contract'
import { invoke, on } from '../ipc'

// Who else is in the Files editor: agents whose writes just landed in an open file (a labeled
// caret and a highlight on the lines they changed, fading AGENT_LINGER_MS after their last edit,
// like an agent's cursor on a canvas), and where Isaac's caret is, here and on his other devices
// (agents read it through `describe`).

/** How long an agent's caret and highlight stay after its last edit. */
export const AGENT_LINGER_MS = 3000
/** The fade at the end of that, matched by files.css. */
export const AGENT_FADE_MS = 600
/** Isaac's caret goes to the host at most this often. */
const CARET_THROTTLE_MS = 250

export interface AgentMark {
  agent: PresenceAgent
  /** Buffer lines the edit changed, 1-based inclusive. */
  ranges: PresenceRange[]
  caret: { line: number; column: number }
  intent?: string
  /** Set for the last AGENT_FADE_MS before the mark goes. */
  fading: boolean
  /** Bumped per edit so the editor redraws a repeated one. */
  seq: number
}

export interface EditorFocus {
  root: string
  path: string
  caret: { line: number; column: number }
  selection?: { start: { line: number; column: number }; end: { line: number; column: number } }
  selectedText?: string
}

interface PresenceState {
  /** By tab key (`root\0path`), one mark per agent name. */
  marks: Record<string, AgentMark[]>
  /** Isaac's caret in this window's editor, with when it last moved. */
  local: (EditorFocus & { at: number }) | null
  /** Isaac's caret on his other devices, newest first, as the host relays it. */
  remote: PresenceFocus[]
}

export const presenceStore = createStore<PresenceState>(() => ({
  marks: {},
  local: null,
  remote: [],
}))

export const markKey = (root: string, path: string): string => `${root}\0${path}`

export function useMarks(root: string, path: string): AgentMark[] | undefined {
  return useStore(presenceStore, (s) => s.marks[markKey(root, path)])
}

let seq = 0
const timers = new Map<string, number[]>()

/** Shows `agent`'s edit in the tab: its caret and changed lines, gone AGENT_LINGER_MS after its last edit. */
export function markEdit(
  root: string,
  path: string,
  mark: Omit<AgentMark, 'fading' | 'seq'>,
): void {
  const key = markKey(root, path)
  const id = `${key}\0${mark.agent.name}`
  for (const t of timers.get(id) ?? []) window.clearTimeout(t)
  const next: AgentMark = { ...mark, fading: false, seq: ++seq }
  const put = (fn: (marks: AgentMark[]) => AgentMark[]): void =>
    presenceStore.setState((s) => {
      const marks = fn(s.marks[key] ?? [])
      const rest = { ...s.marks }
      if (marks.length === 0) delete rest[key]
      else rest[key] = marks
      return { marks: rest }
    })
  const others = (marks: AgentMark[]): AgentMark[] =>
    marks.filter((m) => m.agent.name !== mark.agent.name)
  put((marks) => [...others(marks), next])
  timers.set(id, [
    window.setTimeout(
      () => put((marks) => marks.map((m) => (m.seq === next.seq ? { ...m, fading: true } : m))),
      AGENT_LINGER_MS - AGENT_FADE_MS,
    ),
    window.setTimeout(() => {
      timers.delete(id)
      put(others)
    }, AGENT_LINGER_MS),
  ])
}

let caretTimer: number | undefined
let pendingFocus: EditorFocus | null = null

/** Isaac's caret moved (or left every file: null); the host hears it at most every CARET_THROTTLE_MS. */
export function setLocalFocus(focus: EditorFocus | null): void {
  presenceStore.setState({ local: focus === null ? null : { ...focus, at: Date.now() } })
  pendingFocus = focus
  if (caretTimer !== undefined) return
  void invoke('files.presence.caret', { focus })
  caretTimer = window.setTimeout(() => {
    caretTimer = undefined
    if (pendingFocus !== focus) void invoke('files.presence.caret', { focus: pendingFocus })
  }, CARET_THROTTLE_MS)
}

/**
 * Where Isaac is working in a file, for `describe`: the newest of this window's caret and his
 * other devices' (from the host). `file` is absolute; `device` is null for this window.
 */
export function editorFocus(): {
  file: string
  line: number
  column: number
  selection: EditorFocus['selection'] | null
  selectedText: string | null
  device: string | null
  at: number
} | null {
  const { local, remote } = presenceStore.getState()
  const other = remote[0]
  if (local && (!other || local.at >= other.at)) {
    return {
      file: `${local.root}/${local.path}`,
      line: local.caret.line,
      column: local.caret.column,
      selection: local.selection ?? null,
      selectedText: local.selectedText ?? null,
      device: null,
      at: local.at,
    }
  }
  if (!other) return null
  return {
    file: other.path,
    line: other.caret.line,
    column: other.caret.column,
    selection: other.selection ?? null,
    selectedText: other.selectedText ?? null,
    device: other.deviceName || other.device,
    at: other.at,
  }
}

/** Follows Isaac's caret on his other devices; returns the unsubscribe. */
export function startPresence(): () => void {
  return on('files.presence.focus', ({ focus }) => presenceStore.setState({ remote: focus }))
}

/** Test seam. */
export function resetPresenceForTests(): void {
  for (const ids of timers.values()) for (const t of ids) window.clearTimeout(t)
  timers.clear()
  window.clearTimeout(caretTimer)
  caretTimer = undefined
  pendingFocus = null
  presenceStore.setState({ marks: {}, local: null, remote: [] })
}
