export function ChatPane() {
  return (
    <main className="eva-chat" data-testid="chat-pane">
      <div className="eva-chat-header" data-testid="chat-header" />
      <div className="eva-chat-empty">
        <h2 className="eva-heading">No messages yet</h2>
        <div className="eva-dim">Resume a session to see its messages here.</div>
      </div>
    </main>
  )
}
