import { clipboard, ClipboardItem, nativeImage } from 'electron'
import { coded } from './board-text'
import type { Rescale } from './paste'

/** Electron's rescale for pasted PNG and JPEG (the long edge becomes `edge`, the ratio stays). */
export const electronRescale: Rescale = (bytes, mime, edge) => {
  const img = nativeImage.createFromBuffer(bytes)
  const { width, height } = img.getSize()
  if (width === 0 || height === 0) throw coded('That image could not be read.', 'unsupported')
  const k = edge / Math.max(width, height)
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  const small = img.resize({ width: w, height: h, quality: 'best' })
  return {
    bytes: mime === 'image/jpeg' ? small.toJPEG(90) : small.toPNG(),
    width: w,
    height: h,
  }
}

/** The image a clipboard copy puts there (any type Electron decodes); throws `unsupported` when none. */
export function clipboardImage(bytes: Buffer): Electron.NativeImage {
  const img = nativeImage.createFromBuffer(bytes)
  if (img.isEmpty()) throw coded('That image could not be copied.', 'unsupported')
  return img
}

/** Replaces the system clipboard with this image (any type Electron decodes), as a PNG. */
export async function copyImageToClipboard(bytes: Buffer): Promise<void> {
  const png = new Blob([new Uint8Array(clipboardImage(bytes).toPNG())], { type: 'image/png' })
  await clipboard.write([new ClipboardItem({ 'image/png': png })])
}
