import { useEffect, useState } from 'react'
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
        {image ? <ViewerImage image={image} index={index} total={images.length} /> : null}
      </div>
    </EvaModal>
  )
}
