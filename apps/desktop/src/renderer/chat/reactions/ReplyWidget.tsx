import { Markdown } from '../markdown/Markdown'
import { WidgetScope } from '../widgets/actions'
import { settleReplyWidget, useReplyWidgets } from './reply-widgets'

/** A ```openui or ```ui fence of the reply's own: then it needs no follow-up widget. */
export const OWN_WIDGET_FENCE = /^[ \t>]*(?:`{3,}|~{3,})[ \t]*(?:openui|ui)\b/m

/**
 * The follow-up widget the host's widget agent picked for assistant reply `replyKey` of `thread`,
 * under the reply, drawn by the same OpenUI renderer as a fence in the reply. One that came live
 * fades and slides in once; one the thread opened with just renders. Its rows grow below the
 * reply, so the log never moves what Isaac reads (the log scrolls only for new rows, and rows
 * above the viewport keep the visible ones in place).
 */
export function ReplyWidget({
  thread,
  replyKey,
  messageId,
}: {
  thread: string
  replyKey: string
  messageId: string
}) {
  const block = useReplyWidgets((s) => s.threads[thread]?.[replyKey])
  const arrived = useReplyWidgets((s) => s.arrived[thread]?.[replyKey] === true)
  if (block === undefined) return null
  return (
    <div
      className="eva-reply-widget"
      data-testid="reply-widget"
      data-reply={replyKey}
      data-arrived={arrived || undefined}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) settleReplyWidget(thread, replyKey)
      }}
    >
      {/* Its own widget scope: the reply's own blocks keep theirs. */}
      <WidgetScope.Provider value={`${messageId}:follow-up`}>
        <Markdown text={block} />
      </WidgetScope.Provider>
    </div>
  )
}
