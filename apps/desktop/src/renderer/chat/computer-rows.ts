import { useEffect, useState } from 'react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { invoke, on } from '../ipc'

const NONE: ChatMessage[] = []

/**
 * The pane's `@computer` rows (SPEC.md): main keeps them per pane and pushes the full list on every
 * change; a pane that opens later asks once, matched by its id or its session file.
 */
export function useComputerRows(paneId: string, file: string | null): ChatMessage[] {
  const [rows, setRows] = useState<ChatMessage[]>(NONE)
  useEffect(() => {
    let live = true
    setRows(NONE)
    void invoke('computer.rows', { paneId, file }).then((r) => {
      if (live && r.ok && r.value.rows.length > 0) setRows(r.value.rows)
    })
    const off = on('computer.rows', (e) => {
      if (e.paneId === paneId || (file !== null && e.file === file)) setRows(e.rows)
    })
    return () => {
      live = false
      off()
    }
  }, [paneId, file])
  return rows
}

/**
 * The session's messages with the `@computer` rows in their places: each row goes before the first
 * message stamped after it (`at`: when Isaac sent the command), so a run sits where he started it
 * and later messages come below it. Rows keep their order; unstamped messages (tool calls, the
 * streaming reply) never split a run from what came before them.
 */
export function placeRows(
  messages: readonly ChatMessage[],
  rows: readonly ChatMessage[],
): ChatMessage[] {
  if (rows.length === 0) return [...messages]
  const out: ChatMessage[] = []
  let next = 0
  for (const m of messages) {
    if (m.at !== undefined) {
      while (next < rows.length && (rows[next]!.at ?? Infinity) < m.at) out.push(rows[next++]!)
    }
    out.push(m)
  }
  while (next < rows.length) out.push(rows[next++]!)
  return out
}
