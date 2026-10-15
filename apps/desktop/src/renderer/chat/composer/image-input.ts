import { IMAGE_MIME, MAX_IMAGE_BYTES } from '@evaos/chat-core/launch'

export const ACCEPTED_IMAGE_TYPES = IMAGE_MIME
/** Most images one prompt may carry (contract cap). */
export const MAX_PROMPT_IMAGES = 8

export interface ReadImage {
  mimeType: string
  /** base64 without a data: prefix. */
  data: string
  name: string
  /** Object URL for the chip preview; the owner revokes it. */
  previewUrl: string
}

export type RejectReason = 'not-image' | 'too-large' | null

const accepted = (type: string): boolean =>
  (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'))
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * Reads png/jpeg/gif/webp files up to 20 MB. Other files are skipped and the first reason is
 * reported; oversize files are rejected before any encoding (T-04-28).
 */
export async function readImageFiles(
  files: Iterable<File>,
): Promise<{ images: ReadImage[]; rejected: RejectReason }> {
  const images: ReadImage[] = []
  let rejected: RejectReason = null
  for (const file of files) {
    if (!accepted(file.type)) {
      rejected ??= 'not-image'
      continue
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejected ??= 'too-large'
      continue
    }
    images.push({
      mimeType: file.type,
      data: await toBase64(file),
      name: file.name,
      previewUrl: URL.createObjectURL(file),
    })
  }
  return { images, rejected }
}
