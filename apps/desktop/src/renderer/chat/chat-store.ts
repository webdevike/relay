import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ChatMessage, Dialog, SessionMeta } from '@evaos/chat-core/message'
import type { Op } from '@evaos/contract'

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
  contextWindow: number | null
  thinking: string | null
  /** Set when a draft got its session file from omp; the tab place follows it. */
  boundTo: string | null
}

export interface OpenData {
  file: string
  title: string
  messages: ChatMessage[]
  meta: SessionMeta
}

export interface ChatState {
  panes: Record<string, PaneState>
  openPane(paneId: string, data: OpenData): void
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
      sessionFile?: string | null
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
    contextWindow,
    thinking,
    file,
    boundTo,
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
      if (p.connected !== undefined) stopped = !p.connected
      if (p.dialog !== undefined) dialog = p.dialog
      if (p.contextWindow !== undefined) contextWindow = p.contextWindow
      if (p.thinking !== undefined) thinking = p.thinking
      if (typeof p.sessionFile === 'string' && file === '') {
        file = p.sessionFile
        boundTo = p.sessionFile
      }
      if (p.model !== undefined || p.contextTokens !== undefined) {
        meta = {
          ...meta,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}),
        }
      }
    }
  }
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
    contextWindow,
    thinking,
    boundTo,
    lastSeq: seq,
  }
}

/** Lives outside React so the streaming drain (plan 01-05) can `setState` without a render. */
export const chatStore = createStore<ChatState>((set) => ({
  panes: {},
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
          contextWindow: null,
          thinking: data.meta.thinking ?? null,
          boundTo: null,
        },
      },
    })),
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
        return {
          ...p,
          messages: snap.messages,
          meta: snap.meta,
          running: snap.running,
          stopped: !snap.connected,
          error: dismissed ? null : snap.error,
          dismissedError: dismissed ? p.dismissedError : null,
          dialog: snap.dialog !== undefined ? snap.dialog : p.dialog,
          thinking: snap.meta.thinking ?? p.thinking,
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
