import './chat.css'
import { useEffect, useState } from 'react'
import type { ChatMessage } from '@evaos/chat-core/message'
import { ChatLog } from './ChatLog'
import { invoke } from '../ipc'

/** The log's pane id: no chat pane has it, so its scroll pin stays local to the log. */
const LOG_ID = 'subagent-view'

/** How often a transcript with no chat to tell its changes is looked at for new lines. */
const POLL_MS = 1500

/**
 * A subagent's (or an assistant's session's) transcript, read only. Re-read whenever `version`
 * changes (the subagent file's mtime from the chat's extras), keeping the last read on screen
 * meanwhile. With `poll`, nothing tells this view the file grew (a session an assistant started has
 * no chat of its own here), so it looks at the file's size and mtime and re-reads on a change.
 */
export function SubagentTranscript({
  file,
  version,
  poll = false,
}: {
  file: string
  version: number | null
  poll?: boolean
}) {
  const [read, setRead] = useState<{ file: string; messages: ChatMessage[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [grown, setGrown] = useState(0)

  useEffect(() => {
    if (!poll) return
    let live = true
    let seen: string | null = null
    const look = (): void => {
      void invoke('chat.statSubagent', { file }).then((r) => {
        if (!live || !r.ok) return
        const now = `${r.value.mtimeMs}:${r.value.size}`
        if (seen !== null && seen !== now) setGrown((n) => n + 1)
        seen = now
      })
    }
    look()
    const timer = setInterval(look, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [file, poll])

  useEffect(() => {
    let live = true
    void invoke('chat.readSubagent', { file })
      .then((r) => {
        if (!live) return
        if (r.ok) {
          setRead({ file, messages: r.value.messages })
          setError(null)
        } else setError(r.error.message)
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      live = false
    }
  }, [file, version, grown])

  const messages = read?.file === file ? read.messages : null
  return (
    <div className="eva-subagent-view" data-testid="subagent-transcript">
      {error !== null ? (
        <div className="eva-error-banner" role="alert">
          {error}
        </div>
      ) : null}
      {messages === null ? (
        error === null ? (
          <div className="eva-subagent-empty eva-dim">Loading transcript.</div>
        ) : null
      ) : messages.length === 0 ? (
        <div className="eva-subagent-empty eva-dim">No messages yet.</div>
      ) : (
        <ChatLog paneId={LOG_ID} messages={messages} file={file} />
      )}
    </div>
  )
}
