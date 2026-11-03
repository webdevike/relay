import { useWidgetActions } from './widgets/actions'

/**
 * Tap-to-answer buttons under the newest reply (its `[[replies: ...]]` line). A tap sends the label
 * as Isaac's next message through the composer's send, leaving the draft alone; nothing is sent
 * without one. Disabled where the composer could not send either.
 */
export function ReplyChips({ replies }: { replies: string[] }) {
  const { reply, canReply } = useWidgetActions()
  return (
    <div
      className="eva-reply-chips"
      role="group"
      aria-label="Suggested replies"
      data-testid="reply-chips"
    >
      {replies.map((label) => (
        <button
          key={label}
          type="button"
          className="eva-reply-chip"
          disabled={!canReply}
          onClick={() => reply(label)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
