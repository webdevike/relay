import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWrite } from '@evaos/eva-core/fs/atomic-write'
import { coded } from './board-text'

/** A remote image above this is refused. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
/** Local exports and screenshots can be larger than web references. */
export const MAX_LOCAL_BYTES = 40 * 1024 * 1024

export interface SniffedImage {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  width: number | null
  height: number | null
}

export interface CanvasImage {
  dataUrl: string
  width: number | null
  height: number | null
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i++
      continue
    }
    // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
    }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = b.toString('ascii', 12, 16)
  if (chunk === 'VP8 ' && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  }
  return null
}

/** The image type by magic bytes (never by name or header), and its pixel size when readable. */
export function sniffImage(b: Buffer): SniffedImage | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b)
    return { mime: 'image/jpeg', width: size?.width ?? null, height: size?.height ?? null }
  }
  const head = b.toString('ascii', 0, 6)
  if (b.length >= 10 && (head === 'GIF87a' || head === 'GIF89a')) {
    return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  }
  if (b.length >= 16 && head.startsWith('RIFF') && b.toString('ascii', 8, 12) === 'WEBP') {
    const size = webpSize(b)
    return { mime: 'image/webp', width: size?.width ?? null, height: size?.height ?? null }
  }
  return null
}

function toImage(b: Buffer, what: string): CanvasImage {
  const sniffed = sniffImage(b)
  if (!sniffed) throw coded(`${what} is not a PNG, JPEG, GIF or WebP image.`, 'unsupported')
  return {
    dataUrl: `data:${sniffed.mime};base64,${b.toString('base64')}`,
    width: sniffed.width,
    height: sniffed.height,
  }
}

export type Download = (url: string) => Promise<Buffer>

/** fetch with a timeout, an `image/*` content type and a size cap; `offline` refuses every URL. */
export function createDownload(opts: { timeoutMs?: number; offline?: boolean } = {}): Download {
  return async (url) => {
    if (opts.offline) throw coded('Image downloads are off in tests.', 'not-found')
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) })
    } catch (e) {
      throw coded(`Couldn't download ${url}: ${(e as Error).message}`, 'not-found')
    }
    if (!res.ok) throw coded(`Couldn't download ${url}: HTTP ${res.status}`, 'not-found')
    const type = res.headers.get('content-type') ?? ''
    if (!type.startsWith('image/')) {
      await res.body?.cancel()
      throw coded(`${url} is not an image (${type || 'no content type'}).`, 'unsupported')
    }
    const tooBig = coded(`${url} is larger than 20 MB.`, 'unsupported')
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) {
      await res.body?.cancel()
      throw tooBig
    }
    const chunks: Buffer[] = []
    let size = 0
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength
        if (size > MAX_DOWNLOAD_BYTES) throw tooBig
        chunks.push(Buffer.from(chunk))
      }
    }
    return Buffer.concat(chunks)
  }
}

export interface ImageReader {
  read(src: string): Promise<CanvasImage>
}

/**
 * Native `resolve_src`: an http(s) URL is downloaded once into `cacheDir` (named by the sha256 of
 * the URL); anything else is a file path, absolute or relative to the boards folder.
 */
export function createImageReader(opts: {
  dir: string
  cacheDir: string
  download: Download
}): ImageReader {
  const inflight = new Map<string, Promise<CanvasImage>>()

  async function fetchCached(url: string): Promise<CanvasImage> {
    const cached = path.join(opts.cacheDir, createHash('sha256').update(url).digest('hex'))
    try {
      return toImage(await fs.promises.readFile(cached), url)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const bytes = await opts.download(url)
    const image = toImage(bytes, url)
    await atomicWrite(cached, bytes)
    return image
  }

  async function readLocal(src: string): Promise<CanvasImage> {
    const abs = path.isAbsolute(src) ? src : path.join(opts.dir, src)
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(abs)
    } catch {
      throw coded(`No image at ${src}.`, 'not-found')
    }
    if (!stat.isFile()) throw coded(`No image at ${src}.`, 'not-found')
    if (stat.size > MAX_LOCAL_BYTES) throw coded(`${src} is larger than 40 MB.`, 'unsupported')
    return toImage(await fs.promises.readFile(abs), src)
  }

  return {
    read(src) {
      if (!/^https?:\/\//i.test(src)) return readLocal(src)
      let pending = inflight.get(src)
      if (!pending) {
        pending = fetchCached(src).finally(() => inflight.delete(src))
        inflight.set(src, pending)
      }
      return pending
    },
  }
}
