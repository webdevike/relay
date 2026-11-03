import { useEffect, useState } from 'react'
import { invoke } from '../../ipc'

export type CanvasImage =
  | { state: 'loading' }
  | { state: 'ready'; dataUrl: string; ratio: number | null }
  | { state: 'failed'; message: string }

/** One request per board and source for the life of the window; main caches downloads on disk. */
const cache = new Map<string, Promise<CanvasImage>>()

function fetchImage(slug: string, src: string): Promise<CanvasImage> {
  const key = `${slug}\n${src}`
  let hit = cache.get(key)
  if (!hit) {
    hit = invoke('canvas.image', { slug, src }).then(
      (r): CanvasImage => {
        if (!r.ok) {
          cache.delete(key)
          return { state: 'failed', message: r.error.message }
        }
        const { dataUrl, width, height } = r.value
        return {
          state: 'ready',
          dataUrl,
          ratio: width && height ? height / width : null,
        }
      },
      (): CanvasImage => {
        cache.delete(key)
        return { state: 'failed', message: 'Could not load the image.' }
      },
    )
    cache.set(key, hit)
  }
  return hit
}

/** The picture of an image card: loading, ready with its aspect ratio, or why it failed. */
export function useCanvasImage(slug: string, src: string | undefined): CanvasImage | null {
  const [image, setImage] = useState<CanvasImage | null>(src ? { state: 'loading' } : null)
  useEffect(() => {
    if (!src) {
      setImage(null)
      return
    }
    let live = true
    setImage({ state: 'loading' })
    void fetchImage(slug, src).then((r) => {
      if (live) setImage(r)
    })
    return () => {
      live = false
    }
  }, [slug, src])
  return image
}
