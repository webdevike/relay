import { useEffect, useState } from 'react'
import { ActionIcon } from '@mantine/core'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { ChatImage as ChatImageData } from '@evaos/chat-core/message'
import { EvaModal } from '../overlay'
import { useImageSrc } from './ChatImage'
import './images.css'

function ViewerImage({
  image,
  index,
  total,
}: {
  image: ChatImageData
  index: number
  total: number
}) {
  const url = useImageSrc(image)
  const alt = `Image ${index + 1} of ${total}`
  return url !== null ? <img className="eva-viewer-img" src={url} alt={alt} /> : null
}

export interface ImageViewerProps {
  images: ChatImageData[]
  start: number
  opened: boolean
  onClose: () => void
}

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
  return (
    <EvaModal
      opened={opened}
      onClose={onClose}
      size="90vw"
      title={`Image ${index + 1} of ${images.length}`}
      testid="image-viewer"
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
        {image ? <ViewerImage image={image} index={index} total={images.length} /> : null}
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
    </EvaModal>
  )
}
