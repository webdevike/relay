import { IconArrowDown } from '@tabler/icons-react'

/** Jump to latest (unpinned, no new output) or New reply (unpinned with output); never both. */
export function Pills({
  unpinned,
  newReply,
  onJump,
}: {
  unpinned: boolean
  newReply: boolean
  onJump: () => void
}) {
  if (!unpinned) return null
  return newReply ? (
    <button
      type="button"
      className="eva-pill eva-pill-new"
      data-testid="pill-new-reply"
      onClick={onJump}
    >
      New reply
    </button>
  ) : (
    <button
      type="button"
      className="eva-pill eva-pill-jump"
      data-testid="pill-jump"
      onClick={onJump}
    >
      <IconArrowDown size={14} stroke={1.5} />
      Jump to latest
    </button>
  )
}
