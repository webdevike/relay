import type { OpenAsk } from '@evaos/contract'
import { resolveAsk } from './asks/asks-store'
import { useWidgetActions } from './widgets/actions'

/**
 * Tap-to-answer buttons under the newest reply (its `[[replies: ...]]` line). A tap sends the label
 * as Isaac's next message through the composer's send, leaving the draft alone; nothing is sent
 * without one. Disabled where the composer could not send either. Under an open `ask` of assistant
 * `agent`'s thread, a tap also closes that ask on the host.
 */
export function ReplyChips({
  replies,
  ask,
  agent,
}: {
  replies: string[]
  ask?: OpenAsk
  agent?: string
}) {
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
          onClick={() => {
            reply(label)
            if (ask !== undefined && agent !== undefined)
              void resolveAsk(agent, ask, 'answered', label)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
