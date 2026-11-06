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
