import { useState, type KeyboardEvent } from 'react'
import { IconMoodPlus } from '@tabler/icons-react'
import { MORE_REACTIONS, QUICK_REACTIONS } from '@evaos/chat-core/reactions'

function Pick({
  emoji,
  current,
  onPick,
}: {
  emoji: string
  current: string | null
  onPick(emoji: string): void
}) {
  const active = emoji === current
  return (
    <button
      type="button"
      className="eva-reaction-pick"
      data-testid={`reaction-pick-${emoji}`}
      data-active={active ? 'true' : undefined}
      // The focus trap starts on the current reaction, else the first pick.
      data-autofocus={active ? true : undefined}
      aria-pressed={active}
      aria-label={active ? `Remove ${emoji}` : `React with ${emoji}`}
      onClick={() => onPick(emoji)}
    >
      {emoji}
    </button>
  )
}

/** Left and Right (and Home, End) move between the buttons of the row or grid. */
function roam(e: KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const buttons = [...e.currentTarget.querySelectorAll('button')]
  const at = buttons.findIndex((b) => b === document.activeElement)
  const last = buttons.length - 1
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? last
        : e.key === 'ArrowRight'
          ? Math.min(last, at + 1)
          : Math.max(0, at - 1)
  e.preventDefault()
  buttons[next]?.focus()
}

/**
 * The floating tapback bar: the six quick picks, then "more" for a small emoji grid. The bubble's
 * reaction is highlighted; picking it again takes it off. A reaction from elsewhere that is not a
 * quick pick leads the row so it can be taken off here too.
 */
export function ReactionBar({
  current,
  onPick,
}: {
  current: string | null
  onPick(emoji: string): void
}) {
  const [more, setMore] = useState(false)
  const quick: readonly string[] = QUICK_REACTIONS
  const lead = current !== null && !quick.includes(current) ? [current] : []
  return (
    <div className="eva-reaction-bar" data-testid="reaction-bar">
      <div className="eva-reaction-row" role="toolbar" aria-label="React" onKeyDown={roam}>
        {[...lead, ...quick].map((e) => (
          <Pick key={e} emoji={e} current={current} onPick={onPick} />
        ))}
        <button
          type="button"
          className="eva-reaction-pick eva-reaction-more"
          data-testid="reaction-more"
          aria-label="More reactions"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
        >
          <IconMoodPlus size={18} stroke={1.5} aria-hidden />
        </button>
      </div>
      {more ? (
        <div
          className="eva-reaction-grid"
          role="group"
          aria-label="More reactions"
          data-testid="reaction-grid"
          onKeyDown={roam}
        >
          {MORE_REACTIONS.filter((e) => !lead.includes(e)).map((e) => (
            <Pick key={e} emoji={e} current={current} onPick={onPick} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
