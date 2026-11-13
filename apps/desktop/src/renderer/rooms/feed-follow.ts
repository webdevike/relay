/** Within this many px of the bottom counts as following. */
export const FOLLOW_SLACK_PX = 24

/** The feed's box right after it was pinned to the bottom. */
export interface PinnedBox {
  height: number
  client: number
}

type Box = Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>

/**
 * Whether Isaac scrolled up since the feed was pinned at `was`. Measured against the box as it was
 * pinned, so content added since is not his move; a feed that got shorter or a pane that changed
 * size (both clamp scrollTop) is not either.
 */
export function leftBottom(was: PinnedBox, el: Box): boolean {
  const height = Math.min(was.height, el.scrollHeight)
  const client = Math.max(was.client, el.clientHeight)
  return height - el.scrollTop - client > FOLLOW_SLACK_PX
}
