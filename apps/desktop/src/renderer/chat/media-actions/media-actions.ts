import { notifications } from '@mantine/notifications'
import { invoke } from '../../ipc'

/** A picture or video the media menu and the viewers act on. */
export interface MediaTarget {
  kind: 'image' | 'video'
  /** What the page shows: a `relay-media:` URL, or an image's `data:` URL. */
  url: string
  /** Its caption, which names the saved file. */
  name?: string
}

/** The sources main can save and copy (@evaos/contract media.ts): anything else gets no menu. */
const SAVABLE = /^(?:relay-media:\/\/media\/\?|data:image\/(?:png|jpeg|gif|webp);base64,)/

/** A target for `url` when main can act on it, else null (a blob still loading, a linked file). */
export function mediaTarget(
  kind: MediaTarget['kind'],
  url: string | null | undefined,
  name?: string,
): MediaTarget | null {
  if (!url || !SAVABLE.test(url)) return null
  const caption = name?.trim()
  return caption ? { kind, url, name: caption } : { kind, url }
}

/** Only a source main serves has an address; a pasted image's data: URL has none worth copying. */
export const hasAddress = (t: MediaTarget): boolean => t.url.startsWith('relay-media:')

function failed(title: string, message: string): void {
  notifications.show({ position: 'bottom-right', color: 'red', title, message })
}

/** Save Image As / Save Video As: main's save dialog, opening in Downloads. */
export async function saveMedia(t: MediaTarget): Promise<void> {
  const r = await invoke('media.save', {
    src: t.url,
    ...(t.name === undefined ? {} : { name: t.name }),
  })
  if (!r.ok) failed(`Couldn't save the ${t.kind}`, r.error.message)
}

/**
 * The picture as a PNG data: URL, drawn by the page: for a type Electron can't decode in main
 * (AVIF, SVG). relay-media answers CORS, so the canvas is never tainted. (The renderer's lib has
 * no Promise.withResolvers.)
 */
function rasterize(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const g = canvas.getContext('2d')
      if (!g || canvas.width === 0 || canvas.height === 0) {
        reject(new Error('empty image'))
        return
      }
      g.drawImage(img, 0, 0)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('image failed to load'))
    img.src = url
  })
}

/** Copy Image: its pixels on the clipboard (main writes it; videos are never copied). */
export async function copyImage(t: MediaTarget): Promise<void> {
  if (t.kind !== 'image') return
  let r = await invoke('media.copy', { src: t.url, what: 'image' })
  if (!r.ok && r.error.code === 'unsupported') {
    const png = await rasterize(t.url).catch(() => null)
    if (png !== null) r = await invoke('media.copy', { src: png, what: 'image' })
  }
  if (r.ok) notifications.show({ position: 'bottom-right', message: 'Image copied' })
  else failed("Couldn't copy the image", r.error.message)
}

/** Copy Image Address / Copy Video Address: its URL on the host, or its file's path. */
export async function copyAddress(t: MediaTarget): Promise<void> {
  const r = await invoke('media.copy', { src: t.url, what: 'address' })
  if (r.ok) notifications.show({ position: 'bottom-right', message: 'Address copied' })
  else failed("Couldn't copy the address", r.error.message)
}
