import './chat.css'
import { ChatLog } from './ChatLog'
import { PANE_ID, SessionList } from './SessionList'
import { useChatStore } from './chat-store'

export function ChatPane() {
  const pane = useChatStore((s) => s.panes[PANE_ID])
  return (
    <main className="eva-chat" data-testid="chat-pane">
      <div className="eva-chat-header" data-testid="chat-header">
        {pane ? (
          <>
            <h2 className="eva-heading eva-chat-title">{pane.title}</h2>
            <span className="eva-label eva-dim eva-mono eva-chat-file">
              {pane.file.split('/').pop()}
            </span>
          </>
        ) : null}
      </div>
      {pane ? (
        <ChatLog messages={pane.messages} file={pane.file} />
      ) : (
        <div className="eva-chat-empty">
          <h2 className="eva-heading">No messages yet</h2>
          <div className="eva-dim">Resume a session to see its messages here.</div>
          <SessionList />
        </div>
      )}
    </main>
  )
}
