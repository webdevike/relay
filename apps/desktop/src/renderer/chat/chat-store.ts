import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ChatMessage, SessionMeta } from '@evaos/chat-core/message'

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
}))

export function useChatStore<T>(selector: (s: ChatState) => T): T {
  return useStore(chatStore, selector)
}
