import './chat.css'
import { useEffect } from 'react'
import { ChatLog } from './ChatLog'
import { Composer } from './Composer'
import { PANE_ID, SessionList } from './SessionList'
import { chatStore, useChatStore } from './chat-store'
import { createStreamDrain } from './stream-drain'
import { invoke, on } from '../ipc'
import { placeOf } from '@evaos/shell-core'
import { activePlace, replaceActivePlace, useTabs } from '../tabs/tabs-store'
import { openChatFile, openDraftPane } from './open-chat'

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
  const placeChat = useTabs((s) => {
    const p = activePlace(s)
    return p.page === 'chat' ? p.chat : null
  })

  const activeIx = useTabs((s) => s.tabs.active)

  // A tab whose place is a session path shows that session; a draft tab shows a new chat.
  useEffect(() => {
    if (placeChat === 'draft') void openDraftPane()
    else if (placeChat) void openChatFile(placeChat)
  }, [placeChat, activeIx])

  // A new chat that omp gave a session file: the tab follows it in place, so Back never returns
  // to a dead draft and the pane does not reopen.
  const boundTo = pane?.boundTo ?? null
  useEffect(() => {
    if (boundTo && placeChat === 'draft') replaceActivePlace(placeOf('chat', { chat: boundTo }))
  }, [boundTo, placeChat])

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
              {pane.file ? pane.file.split('/').pop() : ''}
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
      {pane && !(pane.file === '' && pane.messages.length === 0) ? (
        <ChatLog
          paneId={PANE_ID}
          messages={pane.messages}
          // A draft keeps its log key when omp names the file, so binding never jumps the scroll.
          file={pane.boundTo ? '' : pane.file}
        />
      ) : (
        <div className="eva-chat-empty">
          <h2 className="eva-heading">No messages yet</h2>
          <div className="eva-dim">
            {pane
              ? 'Type a message to start a new chat, or resume a session.'
              : 'Resume a session to see its messages here.'}
          </div>
          <SessionList />
        </div>
      )}
      <Composer paneId={PANE_ID} disabled={!pane} />
    </main>
  )
}
