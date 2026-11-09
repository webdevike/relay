import { useState } from 'react'
import { Group, Stack, Text } from '@mantine/core'
import { ImageViewer } from '../../ImageViewer'
import { mediaUrl } from '../media-url'
import { LinkIcon, MediaImage, WidgetTitle } from './parts'

/** Until the image loads, and for galleries always (widgets.rs GALLERY_ASPECT). */
export const DEFAULT_ASPECT = 4 / 3
/** Tall images at their own ratio stop growing at this height over width (DIAGRAM_MAX_RATIO). */
const MAX_HEIGHT_RATIO = 1.5

/** A caption line with the source link icon at its right. */
export function ImageCaption({
  title,
  caption,
  url,
}: {
  title?: string
  caption?: string
  url?: string
}) {
  if (title === undefined && caption === undefined && url === undefined) return null
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
      <Stack gap={0} miw={0}>
        {title !== undefined ? (
          <Text size="sm" fw={500}>
            {title}
          </Text>
        ) : null}
        {caption !== undefined ? (
          <Text size="xs" c="dimmed">
            {caption}
          </Text>
        ) : null}
      </Stack>
      {url !== undefined ? <LinkIcon url={url} label="Open source page" /> : null}
    </Group>
  )
}

/**
 * One framed image (widgets.rs framed_image): drawn at `aspect` when given, else at the image's
 * own ratio (4:3 until it loads), the caption under it; clicking opens the image viewer.
 */
export function FramedImage({
  src,
  alt,
  heading,
  caption,
  url,
  aspect,
  testid,
}: {
  src: string
  alt: string
  heading?: string
  caption?: string
  url?: string
  aspect?: number
  testid: string
}) {
  const [natural, setNatural] = useState<number | null>(null)
  const [viewing, setViewing] = useState(false)
  const shown = aspect ?? Math.max(natural ?? DEFAULT_ASPECT, 1 / MAX_HEIGHT_RATIO)
  const url_ = mediaUrl(src)
  return (
    <Stack gap="sm" data-testid={testid}>
      {heading !== undefined ? <WidgetTitle>{heading}</WidgetTitle> : null}
      <button
        type="button"
        className="eva-w-frame eva-w-frame-button"
        style={{ aspectRatio: shown }}
        aria-label={`Open ${alt}`}
        onClick={() => setViewing(true)}
      >
        <MediaImage src={url_} alt={alt} onAspect={setNatural} origin={{ kind: 'image', src }} />
      </button>
      <ImageCaption caption={caption} url={url} />
      <ImageViewer
        images={[{ label: alt, src: url_ }]}
        start={0}
        opened={viewing}
        onClose={() => setViewing(false)}
      />
    </Stack>
  )
}
