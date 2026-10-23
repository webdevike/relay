import type { DiagramSpec } from '@evaos/chat-core/widget'
import { FramedImage } from './FramedImage'

/**
 * A host-rendered diagram (widgets.rs Node::Diagram): `src` is the rendered image, titled above
 * and captioned below, at its own ratio; clicking opens the image viewer.
 */
export function DiagramWidget({ spec }: { spec: DiagramSpec }) {
  return (
    <FramedImage
      testid="widget-diagram"
      src={spec.src}
      alt={spec.title ?? 'Diagram'}
      heading={spec.title}
      caption={spec.caption}
      url={spec.url}
    />
  )
}
