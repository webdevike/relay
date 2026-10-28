import { useEffect, useState } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconChevronLeft,
  IconChevronRight,
  IconPhoto,
  IconPin,
  IconPlayerPlayFilled,
  IconVideo,
} from '@tabler/icons-react'
import type { Artifact } from '@evaos/chat-core/artifacts'
import { mediaUrl } from '../chat/widgets/media-url'
import { EvaModal } from '../overlay'
import { durationText, isVideo, mediaSource, whenText } from './artifacts-model'

/** A tile's picture: the image itself, or a video's poster frame. */
function tileSrc(item: Artifact): string | null {
  if (isVideo(item)) return item.media?.poster !== undefined ? mediaUrl(item.media.poster) : null
  const src = mediaSource(item)
  return src === null ? null : mediaUrl(src)
}

/** A tile's picture, or a quiet icon when there is none or it does not load (Relay down, a lost drop). */
function TileImage({ src, video }: { src: string | null; video: boolean }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (src === null || failed === src) {
    return (
      <span className="eva-art-tile-missing" aria-hidden="true">
        {video ? <IconVideo size={20} stroke={1.5} /> : <IconPhoto size={20} stroke={1.5} />}
      </span>
    )
  }
  return <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(src)} />
}

/** Every drop and pasted image as a grid: picture, caption, time; a video shows its length. */
export function MediaGrid({
  tiles,
  now,
  onOpen,
}: {
  tiles: readonly Artifact[]
  now: number
  onOpen: (index: number) => void
}) {
  return (
    <div className="eva-art-grid" data-testid="artifacts-media-grid">
      {tiles.map((item, i) => {
        const src = tileSrc(item)
        const caption = item.caption?.trim() || item.title
        return (
          <button
            key={item.id}
            type="button"
            className="eva-art-tile"
            data-testid={`artifact-tile-${item.id}`}
            onClick={() => onOpen(i)}
            aria-label={`Open ${caption}`}
          >
            <span className="eva-art-tile-frame">
              <TileImage src={src} video={isVideo(item)} />
              {isVideo(item) ? (
                <span className="eva-art-tile-badge">
                  <IconPlayerPlayFilled size={10} />
                  {item.media?.durationMs !== undefined
                    ? durationText(item.media.durationMs)
                    : 'Video'}
                </span>
              ) : null}
              {item.pinned ? (
                <span className="eva-art-tile-pin" aria-label="Pinned">
                  <IconPin size={12} stroke={1.5} />
                </span>
              ) : null}
            </span>
            <span className="eva-art-tile-caption">{caption}</span>
            <span className="eva-art-tile-time">{whenText(item.lastSeen, now)}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Steps through the media shown: images at fit size, videos playing with controls. */
export function MediaLightbox({
  items,
  start,
  onClose,
}: {
  items: readonly Artifact[]
  /** The item to open on; null: closed. */
  start: number | null
  onClose: () => void
}) {
  const [index, setIndex] = useState(start ?? 0)
  useEffect(() => {
    if (start !== null) setIndex(start)
  }, [start])
  const opened = start !== null
  const last = items.length - 1
  useEffect(() => {
    if (!opened) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(last, i + 1))
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [opened, last])
  const item = items[Math.min(index, last)]
  const src = item ? mediaSource(item) : null
  const title = item ? item.caption?.trim() || item.title : ''
  return (
    <EvaModal
      opened={opened}
      onClose={onClose}
      fullScreen
      testid="artifacts-lightbox"
      title={
        <span className="eva-art-lb-title">
          <span>{title}</span>
          {items.length > 1 ? (
            <span className="eva-art-lb-count">{`${index + 1} of ${items.length}`}</span>
          ) : null}
        </span>
      }
      actions={
        items.length > 1 ? (
          <>
            <Tooltip label="Previous (Left arrow)" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Previous"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                <IconChevronLeft size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Next (Right arrow)" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="Next"
                disabled={index >= last}
                onClick={() => setIndex((i) => Math.min(last, i + 1))}
              >
                <IconChevronRight size={16} stroke={1.5} />
              </ActionIcon>
            </Tooltip>
          </>
        ) : null
      }
    >
      <div className="eva-art-lb-stage">
        {item && src !== null ? (
          isVideo(item) ? (
            <video
              key={item.id}
              className="eva-art-lb-media"
              src={mediaUrl(src)}
              poster={item.media?.poster !== undefined ? mediaUrl(item.media.poster) : undefined}
              controls
              autoPlay
              data-testid="artifacts-lightbox-video"
            />
          ) : (
            <img key={item.id} className="eva-art-lb-media" src={mediaUrl(src)} alt={title} />
          )
        ) : null}
      </div>
    </EvaModal>
  )
}
