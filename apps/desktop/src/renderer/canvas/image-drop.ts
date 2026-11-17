/**
 * Images arriving on a board from outside: Cmd+V, files dropped from Finder, and pictures dragged
 * out of the chat. This file finds the images in a clipboard or drag payload and lays the cards out.
 */

/** What the chat puts on a dragged picture: its `data:` or `relay-media:` URL. */
export const IMAGE_DRAG_TYPE = 'application/x-relay-image'

/** The largest picture one drop reads (main refuses more than 40 MB). */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024

/** A card's size: the picture fits this box at its own ratio, never enlarged. */
export const CARD_MAX = 480
export const CARD_MIN_W = 120
/** Space between cards of one paste. */
export const ROW_GAP = 24

export function fitImage(
  width: number | null,
  height: number | null,
): { w: number; h: number | null } {
  if (!width || !height) return { w: 320, h: null }
  const k = Math.min(1, CARD_MAX / width, CARD_MAX / height)
  const w = Math.max(CARD_MIN_W, Math.round(width * k))
  return { w, h: Math.round((w * height) / width) }
}

/**
 * Top lefts for cards of these `sizes` in one row. At the pointer (`centered` false) the row starts
 * at `at`; at the view's middle it is centered on `at`.
 */
export function rowPositions(
  sizes: ReadonlyArray<{ w: number; h: number | null }>,
  at: { x: number; y: number },
  centered: boolean,
): Array<[number, number]> {
  const total = sizes.reduce((sum, s) => sum + s.w, 0) + ROW_GAP * Math.max(0, sizes.length - 1)
  const tallest = Math.max(0, ...sizes.map((s) => s.h ?? s.w * 0.75))
  let x = centered ? at.x - total / 2 : at.x
  const y = centered ? at.y - tallest / 2 : at.y
  return sizes.map((s) => {
    const p: [number, number] = [Math.round(x), Math.round(y)]
    x += s.w + ROW_GAP
    return p
  })
}

/** The payload's image types by an `image/*` MIME (a screenshot is PNG, a Finder JPEG is `image/jpeg`). */
const isImageFile = (f: File): boolean => f.type.startsWith('image/')

/** True when a drag may hold an image worth taking (files, or the chat's picture). */
export function mayHoldImage(dt: DataTransfer): boolean {
  const types = Array.from(dt.types)
  return types.includes(IMAGE_DRAG_TYPE) || types.includes('Files')
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

/** The images of a paste or drop as base64, in order; nothing when the payload holds none. */
export async function readTransferImages(dt: DataTransfer): Promise<string[]> {
  const blobs: Blob[] = Array.from(dt.files).filter(isImageFile)
  if (blobs.length === 0) {
    // A browser's "Copy image" lists the picture as a file item; items cover what `files` misses.
    for (const item of Array.from(dt.items))
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) blobs.push(f)
      }
  }
  if (blobs.length === 0) {
    const url = dt.getData(IMAGE_DRAG_TYPE)
    if (url) blobs.push(await (await fetch(url)).blob())
  }
  const out: string[] = []
  for (const b of blobs) {
    if (b.size > MAX_IMAGE_BYTES) throw new Error('That image is larger than 40 MB.')
    out.push(toBase64(await b.arrayBuffer()))
  }
  return out
}
