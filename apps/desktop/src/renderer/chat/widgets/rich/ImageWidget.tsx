import type { ImageSpec } from '@evaos/chat-core/widget'
import { FramedImage } from './FramedImage'

/** One framed image at `aspect` (or its own shape); clicking opens the image viewer. */
export function ImageWidget({ spec }: { spec: ImageSpec }) {
  return (
    <FramedImage
      testid="widget-image"
      src={spec.src}
      alt={spec.alt ?? spec.caption ?? 'Image'}
      caption={spec.caption}
      url={spec.url}
      aspect={spec.aspect}
    />
  )
}
