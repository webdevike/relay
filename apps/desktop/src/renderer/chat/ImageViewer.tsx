import { useEffect, useState } from 'react'
import { ActionIcon } from '@mantine/core'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { ChatImage as ChatImageData } from '@evaos/chat-core/message'
import { EvaModal } from '../overlay'
import { useImageSrc } from './ChatImage'
import { mediaTarget } from './media-actions/media-actions'
import { useMediaMenu } from './media-actions/MediaMenu'
import { useViewerMediaKeys } from './media-actions/useViewerMediaKeys'
import { ViewerDownload } from './media-actions/ViewerDownload'
import './images.css'

const NO_IMAGE: ChatImageData = { label: '' }

export interface ImageViewerProps {
  images: ChatImageData[]
  start: number
  opened: boolean
  onClose: () => void
}

/**
 * The full-size image viewer: arrows step through the images, Download (or Cmd+S) saves the one
 * shown, Cmd+C copies it, and a right-click opens its media menu.
 */
export function ImageViewer({ images, start, opened, onClose }: ImageViewerProps) {
  const [index, setIndex] = useState(start)
  useEffect(() => {
    if (opened) setIndex(start)
  }, [opened, start])
  const last = images.length - 1
  useEffect(() => {
    if (!opened) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(last, i + 1))
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [opened, last])
  const image = images[index]
  // Closed viewers stay mounted under every thumbnail: only an open one reads its image.
  const url = useImageSrc(opened && image ? image : NO_IMAGE)
  const target = mediaTarget('image', url, image?.label)
  useViewerMediaKeys(target, opened)
  const media = useMediaMenu()
  return (
    <EvaModal
      opened={opened}
      onClose={onClose}
      size="90vw"
      title={`Image ${index + 1} of ${images.length}`}
      testid="image-viewer"
      actions={<ViewerDownload target={target} testid="viewer-download" />}
    >
      <div className="eva-image-viewer">
        {images.length > 1 ? (
          <ActionIcon
            className="eva-viewer-nav"
            data-side="prev"
            variant="default"
            size="lg"
            radius="xl"
            aria-label="Previous image"
            data-testid="viewer-prev"
            disabled={index <= 0}
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
          >
            <IconChevronLeft size={20} stroke={1.75} />
          </ActionIcon>
        ) : null}
        {image && url !== null ? (
          <img
            className="eva-viewer-img"
            src={url}
            alt={`Image ${index + 1} of ${images.length}`}
            onContextMenu={media.onContextMenu(target)}
          />
        ) : null}
        {images.length > 1 ? (
          <ActionIcon
            className="eva-viewer-nav"
            data-side="next"
            variant="default"
            size="lg"
            radius="xl"
            aria-label="Next image"
            data-testid="viewer-next"
            disabled={index >= last}
            onClick={() => setIndex((i) => Math.min(last, i + 1))}
          >
            <IconChevronRight size={20} stroke={1.75} />
          </ActionIcon>
        ) : null}
      </div>
      {media.menu}
    </EvaModal>
  )
}
