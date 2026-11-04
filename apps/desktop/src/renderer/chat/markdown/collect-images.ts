import type { ChatImage } from '@evaos/chat-core/message'

/** Marks a viewer-openable markdown image button; the message's images are the ones in its `.eva-md`. */
export const IMAGE_SELECTOR = 'button.eva-md-image'

/**
 * The images of the message `clicked` sits in, in reading order, and the clicked one's position.
 * A message is one `.eva-md`; videos are not buttons and linked images are bare `<img>`s, so
 * neither is included. Outside a `.eva-md` (a Slack file row) the clicked image stands alone.
 */
export function collectMessageImages(clicked: Element): { images: ChatImage[]; start: number } {
  const root = clicked.closest('.eva-md')
  const buttons = root ? [...root.querySelectorAll(IMAGE_SELECTOR)] : [clicked]
  const at = buttons.indexOf(clicked)
  const images: ChatImage[] = buttons.map((b) => {
    const img = b.querySelector('img')
    return { label: img?.getAttribute('alt') ?? '', src: img?.getAttribute('src') ?? '' }
  })
  return { images, start: Math.max(0, at) }
}
