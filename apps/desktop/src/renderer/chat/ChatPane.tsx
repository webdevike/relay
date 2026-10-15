import './chat.css'
import { useEffect } from 'react'
import { ChatLog } from './ChatLog'
import { Composer } from './Composer'
import { PANE_ID, SessionList } from './SessionList'
import { chatStore, useChatStore } from './chat-store'
import { createStreamDrain } from './stream-drain'
import { invoke, on } from '../ipc'

declare global {
  interface Window {
    __evaosChatStats?: Record<
      string,
      { batches: number; gaps: number; snapshots: number; lastSeq: number }
    >
  }
}

export function ChatPane() {
  const pane = useChatStore((s) => s.panes[PANE_ID])

  // One drain for the whole app: batches from main are applied once per animation frame.
  useEffect(() => {
    let e2e = false
    void invoke('app.info', {}).then((r) => {
      e2e = r.ok && r.value.e2e
    })
    const drain = createStreamDrain({
      store: chatStore,
      subscribe: (cb) => on('chat.batch', cb),
      requestSnapshot: async (paneId) => {
        const r = await invoke('chat.snapshot', { paneId })
        return r.ok ? r.value : null
      },
      onStats: (paneId, s) => {
        if (!e2e) return
        window.__evaosChatStats = { ...window.__evaosChatStats, [paneId]: s }
      },
    })
    return () => drain.dispose()
  }, [])

  // An error is a banner, not a lock: the next send retries (and restarts omp if it exited).
  return (
    <main className="eva-chat" data-testid="chat-pane">
      <div className="eva-chat-header" data-testid="chat-header">
        {pane ? (
          <>
            {pane.running ? (
              <span className="eva-streaming-dot" role="img" aria-label="Eva is replying" />
            ) : null}
            <h2 className="eva-heading eva-chat-title">{pane.title}</h2>
            <span className="eva-label eva-dim eva-mono eva-chat-file">
              {pane.file.split('/').pop()}
            </span>
            {pane.reconnecting ? (
              <span className="eva-label eva-dim eva-chat-reconnecting">
                Reconnecting to the stream.
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {pane?.error ? (
        <div className="eva-error-banner" role="alert" data-testid="chat-error">
          {pane.error}
        </div>
      ) : null}
      {pane ? (
        <ChatLog paneId={PANE_ID} messages={pane.messages} file={pane.file} />
      ) : (
        <div className="eva-chat-empty">
          <h2 className="eva-heading">No messages yet</h2>
          <div className="eva-dim">Resume a session to see its messages here.</div>
          <SessionList />
        </div>
      )}
      <Composer paneId={PANE_ID} disabled={!pane} />
    </main>
  )
}
