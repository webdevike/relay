import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { toOpenUI } from '@evaos/chat-core/openui'
import type { ChatMessage } from '@evaos/chat-core/message'
import type { Portrait } from '@relay/portrait-motion'

/**
 * Rows this app adds to a chat that omp never wrote: a tool the header opens in the thread (the
 * avatar editor). They render like any assistant reply, after the session's messages, and are not
 * part of the session: Save or Cancel dismisses them, and so does closing the pane.
 */
const store = createStore<{ rows: Record<string, ChatMessage[]> }>(() => ({ rows: {} }))

const NONE: ChatMessage[] = []

/** `paneId`'s local rows, oldest first. */
export function useLocalRows(paneId: string): ChatMessage[] {
  return useStore(store, (s) => s.rows[paneId] ?? NONE)
}

/** Appends a row to the pane's thread. */
export function postLocalRow(paneId: string, row: ChatMessage): void {
  store.setState((s) => ({ rows: { ...s.rows, [paneId]: [...(s.rows[paneId] ?? []), row] } }))
}

/** Removes the row `id` wherever it is; nothing happens for a row that is not local. */
export function dismissLocalRow(id: string): void {
  if (!id.startsWith(LOCAL_PREFIX)) return
  store.setState((s) => ({
    rows: Object.fromEntries(
      Object.entries(s.rows).map(([pane, rows]) => [pane, rows.filter((r) => r.id !== id)]),
    ),
  }))
}

/** Forgets a pane's rows (the pane closed). */
export function dropLocalRows(paneId: string): void {
  store.setState((s) => {
    const { [paneId]: _gone, ...rows } = s.rows
    return { rows }
  })
}

const LOCAL_PREFIX = 'local:'
const EDITOR_PREFIX = `${LOCAL_PREFIX}avatar-editor:`
let counter = 0

/**
 * Opens the avatar editor for `agent` in the pane's thread, starting from its `current` portrait:
 * an assistant row holding an `openui` fence, the same reply the agent could write itself. One
 * editor per pane: while it is open another call leaves it be.
 */
export function openAvatarEditor(paneId: string, agent: string, current: Portrait): void {
  if (store.getState().rows[paneId]?.some((r) => r.id.startsWith(EDITOR_PREFIX))) return
  const program = toOpenUI({ widget: 'avatarEditor', agent, current })
  postLocalRow(paneId, {
    id: `${EDITOR_PREFIX}${String(++counter)}`,
    role: 'assistant',
    text: '```openui\n' + program + '\n```',
    detail: '',
    streaming: false,
    images: [],
  })
}
