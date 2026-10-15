import * as fs from 'node:fs'
import * as path from 'node:path'
import { imageSize } from '@evaos/chat-core/image-size'
import { MAX_IMAGE_BYTES } from '@evaos/chat-core/launch'

export class MediaError extends Error {
  constructor(
    readonly code: 'image-not-found' | 'image-too-large' | 'not-an-image',
    message: string,
  ) {
    super(message)
  }
}

const TOKEN = /^blob:sha256:([a-f0-9]{64})$/
const EXTENSIONS = ['', '.png', '.jpg', '.jpeg', '.gif', '.webp']

/**
 * Reads one image from omp's blob store (`<agentDir>/blobs/<hash>[.ext]`) as a data URL.
 * The token is a strict hash, the resolved file must stay inside the blobs directory, and the
 * size is checked before the read. Only png, jpeg, gif and webp bytes are returned.
 */
export function readBlobImage(
  agentDir: string,
  token: string,
): { dataUrl: string; width: number | null; height: number | null } {
  const match = TOKEN.exec(token)
  if (!match) throw new MediaError('image-not-found', 'Not a blob token')
  const hash = match[1] as string
  let base: string
  try {
    base = fs.realpathSync(path.join(agentDir, 'blobs'))
  } catch {
    throw new MediaError('image-not-found', 'No blob store')
  }
  for (const ext of EXTENSIONS) {
    let real: string
    try {
      real = fs.realpathSync(path.join(base, hash + ext))
    } catch {
      continue
    }
    if (!real.startsWith(base + path.sep)) continue
    const stat = fs.statSync(real)
    if (!stat.isFile()) continue
    if (stat.size > MAX_IMAGE_BYTES) throw new MediaError('image-too-large', 'Image is over 20 MB')
    const bytes = fs.readFileSync(real)
    const size = imageSize(bytes.subarray(0, 65_536))
    if (size === null) throw new MediaError('not-an-image', 'Not a png, jpeg, gif or webp image')
    return {
      dataUrl: `data:${size.mime};base64,${bytes.toString('base64')}`,
      width: size.width,
      height: size.height,
    }
  }
  throw new MediaError('image-not-found', 'Blob not found')
}
