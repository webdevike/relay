import { useMemo, useState } from 'react'
import { Group, Stack } from '@mantine/core'
import type { GallerySpec } from '@evaos/chat-core/widget'
import { ImageViewer } from '../../ImageViewer'
import { mediaUrl } from '../media-url'
import { DEFAULT_ASPECT, ImageCaption } from './FramedImage'
import { MediaImage, Pager, WidgetTitle } from './parts'

/**
 * Image carousel (widgets.rs gallery): one image per page in a 4:3 frame, chevrons and dots in
 * the header, title and caption under it with the source link; clicking opens the image viewer
 * on the same page, so closing it keeps the page.
 */
export function GalleryWidget({ spec }: { spec: GallerySpec }) {
  const [page, setPage] = useState(0)
  const [viewing, setViewing] = useState(false)
  const count = spec.images.length
  const index = Math.min(page, count - 1)
  const image = spec.images[index]!
  const viewerImages = useMemo(
    () =>
      spec.images.map((img, i) => ({
        label: img.title ?? `Image ${i + 1}`,
        src: mediaUrl(img.src),
      })),
    [spec.images],
  )
  const alt = image.title ?? `Image ${index + 1} of ${count}`
  return (
    <Stack gap="sm" data-testid="widget-gallery">
      {spec.title !== undefined || count > 1 ? (
        <Group justify="space-between" wrap="wrap" gap="sm">
          {spec.title !== undefined ? <WidgetTitle>{spec.title}</WidgetTitle> : <span />}
          <Pager index={index} count={count} onChange={setPage} label="Image" />
        </Group>
      ) : null}
      <button
        type="button"
        className="eva-w-frame eva-w-frame-button"
        style={{ aspectRatio: DEFAULT_ASPECT }}
        aria-label={`Open ${alt}`}
        onClick={() => setViewing(true)}
      >
        <MediaImage
          key={index}
          src={viewerImages[index]!.src}
          alt={alt}
          origin={{ kind: 'gallery', src: image.src }}
        />
      </button>
      <ImageCaption title={image.title} caption={image.caption} url={image.url} />
      <ImageViewer
        images={viewerImages}
        start={index}
        opened={viewing}
        onClose={() => setViewing(false)}
      />
    </Stack>
  )
}
