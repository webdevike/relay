import type { Ref } from 'react'

/**
 * A bubble's reaction, a small disc on its top corner (iMessage's tapback). With `onOpen` it is the
 * way to change it: the bar opens on click, Enter or Space.
 */
export function ReactionBadge({
  emoji,
  testId,
  onOpen,
  expanded = false,
  ref,
}: {
  emoji: string
  testId: string
  onOpen?: () => void
  expanded?: boolean
  ref?: Ref<HTMLButtonElement>
}) {
  if (!onOpen) {
    return (
      <span
        className="eva-reaction-badge"
        data-testid={testId}
        role="img"
        aria-label={`Reacted ${emoji}`}
      >
        {emoji}
      </span>
    )
  }
  return (
    <button
      ref={ref}
      type="button"
      className="eva-reaction-badge"
      data-testid={testId}
      aria-label={`Reacted ${emoji}. Change reaction`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      {emoji}
    </button>
  )
}
