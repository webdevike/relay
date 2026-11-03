import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AwayView } from '@evaos/chat-core/batcher'
import { subagentFinished } from '@evaos/chat-core/jobs'
import type {
  BgJob,
  ChatMessage,
  Dialog,
  Goal,
  SessionMeta,
  Subagent,
} from '@evaos/chat-core/message'
import type { Extras, Op } from '@evaos/contract'

export interface PaneExtras {
  subagents: Subagent[]
  jobs: BgJob[]
  /** This app's omp process for the pane runs. */
  running: boolean
}

export const NO_EXTRAS: PaneExtras = { subagents: [], jobs: [], running: false }

export const hiddenKey = (file: string, name: string): string => `${file}\0${name}`

export interface PaneState {
  /** Empty for a draft chat until omp reports the session file it created. */
  file: string
  title: string
  messages: ChatMessage[]
  meta: SessionMeta
  running: boolean
  /** True after omp exited or was closed; the next send starts a new process. */
  stopped: boolean
  unpinned: boolean
  newReply: boolean
  lastSeq: number
  reconnecting: boolean
  error: string | null
  /**
   * The banner text the user dismissed by typing. Main keeps its error until the next prompt,
   * so a resync snapshot carrying this same text must not bring the banner back.
   */
  dismissedError: string | null
  /** The open question omp is asking, if any. */
  dialog: Dialog | null
  /** A question that was open when omp exited unanswered: shown dimmed until a new one or a restart. */
  deadDialog: Dialog | null
  /** omp's goal while active or paused, shown in the strip over the composer. */
  goal: Goal | null
  /** A `/handoff` is generating. */
  handingOff: boolean
  contextWindow: number | null
  thinking: string | null
  /** Set when a draft got its session file from omp; the tab place follows it. */
  boundTo: string | null
  /** omp runs this chat outside this app and the pane drives it through Relay. */
  away: AwayView | null
  /** Subagents and background jobs main derives from the session files. */
  extras: PaneExtras
  /** The pane that owned this file when it was opened (null when none). */
  owner?: string | null
}

export interface OpenData {
  file: string
  title: string
  messages: ChatMessage[]
  meta: SessionMeta
  /** The pane that runs omp for this file when it is not this one. */
  owner?: string | null
}

export interface ChatState {
  panes: Record<string, PaneState>
  /** Finished subagent chips cleared by the user, as `hiddenKey`s, for this app run. */
  hiddenDone: ReadonlySet<string>
  /** Extras that arrived before their pane was opened (main emits during `chat.open`). */
  pendingExtras: Record<string, PaneExtras>
  setExtras(e: Extras): void
  clearDone(paneId: string): void
  openPane(paneId: string, data: OpenData): void
  /** Forgets a pane that went away (a tool pane's chat tab closed). */
  dropPane(paneId: string): void
  setMessages(paneId: string, messages: ChatMessage[]): void
  /** Applies one drained batch worth of ops. Only changed rows get a new object identity. */
  applyOps(paneId: string, ops: Op[], seq: number): void
  /** Replaces the pane with a `chat.snapshot`; `connected` and `error` come along so a lost `_eof` batch is not lost twice. */
  applySnapshot(
    paneId: string,
    snap: {
      seq: number
      messages: ChatMessage[]
      meta: SessionMeta
      running: boolean
      connected: boolean
      error: string | null
      dialog?: Dialog | null
      goal?: Goal | null
      handingOff?: boolean
      sessionFile?: string | null
      away?: AwayView | null
      title?: string
    },
  ): void
  setPin(paneId: string, unpinned: boolean, newReply: boolean): void
  setReconnecting(paneId: string, value: boolean): void
  setError(paneId: string, error: string | null): void
  /** Hides the current error banner locally (the user is typing); a new error shows again. */
  dismissError(paneId: string): void
}

function patchPane(
  s: ChatState,
  paneId: string,
  fn: (p: PaneState) => PaneState,
): Partial<ChatState> | ChatState {
  const pane = s.panes[paneId]
  return pane ? { panes: { ...s.panes, [paneId]: fn(pane) } } : s
}

export function applyOpsToPane(pane: PaneState, ops: Op[], seq: number): PaneState {
  let messages = pane.messages
  let copied = false
  const own = (): ChatMessage[] => {
    if (!copied) {
      messages = messages.slice()
      copied = true
    }
    return messages
  }
  let {
    running,
    error,
    meta,
    stopped,
    dismissedError,
    dialog,
    deadDialog,
    goal,
    handingOff,
    contextWindow,
    thinking,
    file,
    boundTo,
    away,
    title,
  } = pane
  for (const op of ops) {
    if (op.op === 'upsert') {
      const ix = messages.findLastIndex((m) => m.id === op.message.id)
      if (ix >= 0) own()[ix] = op.message
      else {
        const at = Math.min(Math.max(op.at ?? messages.length, 0), messages.length)
        own().splice(at, 0, op.message)
      }
    } else if (op.op === 'remove') {
      const ix = messages.findLastIndex((m) => m.id === op.id)
      if (ix >= 0) own().splice(ix, 1)
    } else {
      const p = op.patch
      if (p.running !== undefined) running = p.running
      if (p.error !== undefined) {
        // A batch is main speaking now: a fresh error shows even if the last one was dismissed.
        error = p.error
        dismissedError = null
      }
      if (p.connected !== undefined) {
        stopped = !p.connected
        if (p.connected) deadDialog = null
      }
      if (p.dialog !== undefined) dialog = p.dialog
      if (dialog !== null) deadDialog = null
      if (p.goal !== undefined) goal = p.goal
      if (p.handingOff !== undefined) handingOff = p.handingOff
      if (p.contextWindow !== undefined) contextWindow = p.contextWindow
      if (p.thinking !== undefined) thinking = p.thinking
      if (typeof p.sessionFile === 'string' && file === '') {
        file = p.sessionFile
        boundTo = p.sessionFile
      }
      if (p.away !== undefined) away = p.away
      if (p.title !== undefined) title = p.title
      if (p.model !== undefined || p.contextTokens !== undefined) {
        meta = {
          ...meta,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}),
        }
      }
    }
  }
  // The dialog cleared because omp exited, not because it was answered: keep it as a dead card.
  if (pane.dialog !== null && dialog === null && stopped) deadDialog = pane.dialog
  return {
    ...pane,
    file,
    messages,
    running,
    error,
    meta,
    stopped,
    dismissedError,
    dialog,
    deadDialog,
    goal,
    handingOff,
    contextWindow,
    thinking,
    boundTo,
    away,
    title,
    lastSeq: seq,
  }
}

/** Lives outside React so the streaming drain (plan 01-05) can `setState` without a render. */
export const chatStore = createStore<ChatState>((set) => ({
  panes: {},
  hiddenDone: new Set<string>(),
  pendingExtras: {},
  setExtras: (e) =>
    set((s) => {
      const extras = { subagents: e.subagents, jobs: e.jobs, running: e.running }
      return s.panes[e.paneId]
        ? patchPane(s, e.paneId, (p) => ({ ...p, extras }))
        : { pendingExtras: { ...s.pendingExtras, [e.paneId]: extras } }
    }),
  clearDone: (paneId) =>
    set((s) => {
      const pane = s.panes[paneId]
      if (!pane) return s
      const next = new Set(s.hiddenDone)
      for (const a of pane.extras.subagents) {
        if (subagentFinished(a, Date.now())) next.add(hiddenKey(pane.file, a.name))
      }
      return { hiddenDone: next }
    }),
  openPane: (paneId, data) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [paneId]: {
          ...data,
          running: false,
          stopped: false,
          unpinned: false,
          newReply: false,
          lastSeq: 0,
          reconnecting: false,
          error: null,
          dismissedError: null,
          dialog: null,
          deadDialog: null,
          goal: null,
          handingOff: false,
          contextWindow: null,
          thinking: data.meta.thinking ?? null,
          boundTo: null,
          away: null,
          // Main emits extras for the new file before this resolves, so what the pane (or the
          // pending slot) already holds is for this file.
          extras:
            data.file === ''
              ? NO_EXTRAS
              : (s.panes[paneId]?.extras ?? s.pendingExtras[paneId] ?? NO_EXTRAS),
        },
      },
    })),
  dropPane: (paneId) =>
    set((s) => {
      const { [paneId]: _gone, ...panes } = s.panes
      const { [paneId]: _pending, ...pendingExtras } = s.pendingExtras
      return { panes, pendingExtras }
    }),
  setMessages: (paneId, messages) =>
    set((s) => {
      const pane = s.panes[paneId]
      return pane ? { panes: { ...s.panes, [paneId]: { ...pane, messages } } } : s
    }),
  applyOps: (paneId, ops, seq) =>
    set((s) => patchPane(s, paneId, (p) => applyOpsToPane(p, ops, seq))),
  applySnapshot: (paneId, snap) =>
    set((s) =>
      patchPane(s, paneId, (p) => {
        // Main still reports the error the user dismissed by typing: keep it hidden.
        const dismissed = snap.error !== null && snap.error === p.dismissedError
        const dialog = snap.dialog !== undefined ? snap.dialog : p.dialog
        const deadDialog =
          dialog !== null || snap.connected ? null : p.dialog !== null ? p.dialog : p.deadDialog
        return {
          ...p,
          messages: snap.messages,
          meta: snap.meta,
          running: snap.running,
          stopped: !snap.connected,
          error: dismissed ? null : snap.error,
          dismissedError: dismissed ? p.dismissedError : null,
          dialog,
          deadDialog,
          goal: snap.goal !== undefined ? snap.goal : p.goal,
          handingOff: snap.handingOff ?? p.handingOff,
          thinking: snap.meta.thinking ?? p.thinking,
          contextWindow: snap.meta.contextWindow ?? p.contextWindow,
          away: snap.away !== undefined ? snap.away : p.away,
          title: snap.title ?? p.title,
          ...(typeof snap.sessionFile === 'string' && p.file === ''
            ? { file: snap.sessionFile, boundTo: snap.sessionFile }
            : {}),
          lastSeq: snap.seq,
        }
      }),
    ),
  setPin: (paneId, unpinned, newReply) =>
    set((s) =>
      patchPane(s, paneId, (p) =>
        p.unpinned === unpinned && p.newReply === newReply ? p : { ...p, unpinned, newReply },
      ),
    ),
  setReconnecting: (paneId, value) =>
    set((s) =>
      patchPane(s, paneId, (p) => (p.reconnecting === value ? p : { ...p, reconnecting: value })),
    ),
  setError: (paneId, error) =>
    set((s) => patchPane(s, paneId, (p) => ({ ...p, error, dismissedError: null }))),
  dismissError: (paneId) =>
    set((s) =>
      patchPane(s, paneId, (p) =>
        p.error === null ? p : { ...p, error: null, dismissedError: p.error },
      ),
    ),
}))

export function useChatStore<T>(selector: (s: ChatState) => T): T {
  return useStore(chatStore, selector)
}
