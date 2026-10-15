import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ChatMessage, SessionMeta } from '@evaos/chat-core/message'
import type { Op } from '@evaos/contract'

export interface PaneState {
  file: string
  title: string
  messages: ChatMessage[]
  meta: SessionMeta
  running: boolean
  unpinned: boolean
  newReply: boolean
  lastSeq: number
  reconnecting: boolean
  error: string | null
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
  applySnapshot(
    paneId: string,
    snap: { seq: number; messages: ChatMessage[]; meta: SessionMeta; running: boolean },
  ): void
  setReconnecting(paneId: string, value: boolean): void
  setError(paneId: string, error: string | null): void
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
  let { running, error, meta } = pane
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
      if (p.error !== undefined) error = p.error
      if (p.model !== undefined || p.contextTokens !== undefined) {
        meta = {
          ...meta,
          ...(p.model !== undefined ? { model: p.model } : {}),
          ...(p.contextTokens !== undefined ? { contextTokens: p.contextTokens } : {}),
        }
      }
    }
  }
  return { ...pane, messages, running, error, meta, lastSeq: seq }
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
          unpinned: false,
          newReply: false,
          lastSeq: 0,
          reconnecting: false,
          error: null,
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
      patchPane(s, paneId, (p) => ({
        ...p,
        messages: snap.messages,
        meta: snap.meta,
        running: snap.running,
        lastSeq: snap.seq,
      })),
    ),
  setReconnecting: (paneId, value) =>
    set((s) =>
      patchPane(s, paneId, (p) => (p.reconnecting === value ? p : { ...p, reconnecting: value })),
    ),
  setError: (paneId, error) => set((s) => patchPane(s, paneId, (p) => ({ ...p, error }))),
}))

export function useChatStore<T>(selector: (s: ChatState) => T): T {
  return useStore(chatStore, selector)
}
