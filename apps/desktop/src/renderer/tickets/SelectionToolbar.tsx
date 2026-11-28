// The small bar over text selected in a ticket's description: Comment (an inline comment on those
// words, through the gate) and Quote (`> text` into the main comment box).
import { Button } from '@mantine/core'
import { IconMessagePlus, IconQuote } from '@tabler/icons-react'

/** A box in the description's overlay layer (px from its top left). */
export interface Box {
  top: number
  left: number
  width: number
  height: number
}

export function SelectionToolbar({
  at,
  canComment,
  onComment,
  onQuote,
}: {
  at: Box
  /** Inline comments need the host's gate and the description's document id. */
  canComment: boolean
  onComment: () => void
  onQuote: () => void
}) {
  return (
    <div
      className="eva-tk-seltools"
      style={{ top: at.top, left: at.left }}
      role="toolbar"
      aria-label="Selected text"
      // Pressing a button must not drop the selection it acts on.
      onMouseDown={(e) => e.preventDefault()}
      data-testid="selection-toolbar"
    >
      {canComment ? (
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconMessagePlus size={12} />}
          onClick={onComment}
          data-testid="selection-comment"
        >
          Comment
        </Button>
      ) : null}
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        leftSection={<IconQuote size={12} />}
        onClick={onQuote}
        data-testid="selection-quote"
      >
        Quote
      </Button>
    </div>
  )
}
