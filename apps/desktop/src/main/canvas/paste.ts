import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { atomicWrite } from '@evaos/eva-core/fs/atomic-write'
import { coded } from './board-text'
import { MAX_LOCAL_BYTES, sniffImage, type SniffedImage } from './images'

/** A stored image's long edge never exceeds this; a larger paste (a 5K screenshot) is scaled down. */
export const MAX_STORED_EDGE = 2560

const EXTENSION: Record<SniffedImage['mime'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Scales a PNG or JPEG so its long edge is `edge`; returns the new bytes and size. */
export type Rescale = (
  bytes: Buffer,
  mime: 'image/png' | 'image/jpeg',
  edge: number,
) => { bytes: Buffer; width: number; height: number }

export interface StoredBoardImage {
  /** Relative to the boards folder: what an image card's `data.src` keeps. */
  src: string
  width: number | null
  height: number | null
}

/** Where a board's image files go: the boards folder here, or the host's on a thin client. */
export type BoardImageTarget =
  { dir: string } | { writeAsset: (src: string, bytes: Buffer) => Promise<void> }

/**
 * Writes a pasted or dropped image into `assets/<slug>/` of the boards folder, named by the
 * sha256 of what is stored (so pasting the same picture twice keeps one file). PNG and JPEG above
 * MAX_STORED_EDGE are rescaled; GIF and WebP stay as they are (scaling would drop frames).
 */
export async function storeBoardImage(
  opts: {
    slug: string
    bytes: Buffer
    rescale: Rescale
  } & BoardImageTarget,
): Promise<StoredBoardImage> {
  const { bytes } = opts
  if (bytes.length > MAX_LOCAL_BYTES) throw coded('That image is larger than 40 MB.', 'unsupported')
  const sniffed = sniffImage(bytes)
  if (!sniffed) throw coded('That is not a PNG, JPEG, GIF or WebP image.', 'unsupported')
  let out = bytes
  let { width, height } = sniffed
  if (
    (sniffed.mime === 'image/png' || sniffed.mime === 'image/jpeg') &&
    width !== null &&
    height !== null &&
    Math.max(width, height) > MAX_STORED_EDGE
  ) {
    const scaled = opts.rescale(bytes, sniffed.mime, MAX_STORED_EDGE)
    out = scaled.bytes
    width = scaled.width
    height = scaled.height
  }
  const name = `${createHash('sha256').update(out).digest('hex').slice(0, 16)}.${EXTENSION[sniffed.mime]}`
  const rel = `assets/${opts.slug}/${name}`
  if ('writeAsset' in opts) {
    await opts.writeAsset(rel, out)
  } else {
    const abs = path.join(opts.dir, rel)
    if (!fs.existsSync(abs)) await atomicWrite(abs, out)
  }
  return { src: rel, width, height }
}
