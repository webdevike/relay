import { useEffect, useState } from 'react'
import type { ChatImage as ChatImageData } from '@evaos/chat-core/message'
import { invoke } from '../ipc'
import './images.css'

export const THUMB_MAX = 240
export const THUMB_PLACEHOLDER = 160

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/
const BLOB_TOKEN = /^blob:sha256:[a-f0-9]{64}$/

/** Decoded data URLs can be about 27 MB each, so only the most recent few stay in memory. */
export const BLOB_CACHE_MAX = 24

const blobCache = new Map<string, Promise<string | null>>()

/**
 * One chat.readImage per token while it stays cached. Failures are never cached (omp may still be
 * writing the blob), and the least recently used entry is evicted past BLOB_CACHE_MAX.
 */
export function loadBlob(token: string): Promise<string | null> {
  const hit = blobCache.get(token)
  if (hit) {
    blobCache.delete(token)
    blobCache.set(token, hit)
    return hit
  }
  const pending = invoke('chat.readImage', { token })
    .then((r) => (r.ok ? r.value.dataUrl : null))
    .catch(() => null)
    .then((url) => {
      if (url === null && blobCache.get(token) === pending) blobCache.delete(token)
      return url
    })
  blobCache.set(token, pending)
  while (blobCache.size > BLOB_CACHE_MAX) {
    const oldest = blobCache.keys().next().value
    if (oldest === undefined) break
    blobCache.delete(oldest)
  }
  return pending
}

/** Test hook: forget every cached blob. */
export function clearBlobCache(): void {
  blobCache.clear()
}

/** The `<img>` source for an image: a safe data URL now, or a blob read in flight (null until it lands). */
export function useImageSrc(image: ChatImageData): string | null {
  const src = image.src
  const direct = src !== undefined && DATA_IMAGE.test(src) ? src : null
  const [blob, setBlob] = useState<string | null>(null)
  useEffect(() => {
    setBlob(null)
    if (src === undefined || !BLOB_TOKEN.test(src)) return
    let live = true
    void loadBlob(src).then((url) => {
      if (live) setBlob(url)
    })
    return () => {
      live = false
    }
  }, [src])
  return direct ?? blob
}

/** Reserved box: scaled to fit 240 by 240 from known dimensions, else a fixed square that never resizes on load. */
export function thumbBox(image: ChatImageData): { width: number; height: number } {
  const { width, height } = image
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return { width: THUMB_PLACEHOLDER, height: THUMB_PLACEHOLDER }
  }
  const scale = Math.min(1, THUMB_MAX / width, THUMB_MAX / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface ChatImageProps {
  image: ChatImageData
  index: number
  total: number
  onOpen: () => void
}

export function ChatImage({ image, index, total, onOpen }: ChatImageProps) {
  const url = useImageSrc(image)
  const box = thumbBox(image)
  const alt = `Image ${index + 1} of ${total}`
  return (
    <button
      type="button"
      className="eva-chat-image"
      style={{ width: box.width, height: box.height }}
      data-known={image.width !== undefined && image.height !== undefined}
      aria-label={url === null ? alt : undefined}
      onClick={onOpen}
    >
      {url !== null ? <img src={url} alt={alt} draggable={false} /> : null}
    </button>
  )
}
