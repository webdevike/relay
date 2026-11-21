// Save Image As, Save Video As, Copy Image and Copy Address for a chat's media. The renderer names
// a picture or video by what it shows (a relay-media: URL or an image's data: URL, see
// @evaos/contract media.ts); a relay-media: src resolves exactly as the scheme serves it
// (chat/widget-media.ts: the cached download or the local file), so nothing here fetches or reads
// anything the renderer could not already show. Electron stays out of this file (media-ipc.ts).
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  MediaError,
  mediaAddress,
  mediaTypeOf,
  resolveMedia,
  type MediaDeps,
} from '../chat/widget-media'
import { extensionFor, mediaFileName } from './file-name'

export interface MediaActionDeps {
  media: MediaDeps
  /** Where the save dialog opens (`~/Downloads`). */
  downloadsDir(): string
  /** The save dialog: the path Isaac picked, or null when he cancelled. */
  chooseSavePath(opts: { defaultPath: string; title: string }): Promise<string | null>
  /** Replaces the clipboard with this image; throws `unsupported` when it can't be decoded. */
  writeImage(bytes: Buffer): Promise<void>
  writeText(text: string): void
  /** A file was saved (the e2e hook records it). */
  onSaved?(file: string): void
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * A resolve failure in words that never repeat its URL (a drop's token, a signed query): Relay
 * being down says so, the rest say what happened.
 */
function unavailable(e: unknown): unknown {
  if (!(e instanceof MediaError)) return e
  const message =
    e.status === 503
      ? e.message
      : e.status === 404
        ? "It's no longer there."
        : e.status === 413
          ? "It's too large."
          : e.status === 502
            ? "It couldn't be downloaded."
            : "That isn't a media file."
  return coded(message, 'media-unavailable')
}

const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,/

/** What a media ref names: the `src` inside a relay-media: URL, or a data: image's bytes. */
export type MediaSource =
  { kind: 'relay'; src: string } | { kind: 'data'; type: string; bytes: Buffer }

export function parseMediaRef(ref: string): MediaSource {
  const data = DATA_IMAGE.exec(ref)
  if (data) {
    const bytes = Buffer.from(ref.slice(data[0].length), 'base64')
    if (bytes.length === 0) throw coded('That image is empty.', 'not-media')
    return { kind: 'data', type: data[1]!, bytes }
  }
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    throw coded('Not a media address.', 'not-media')
  }
  const src = url.searchParams.get('src')
  if (url.protocol !== 'relay-media:' || url.host !== 'media' || url.pathname !== '/' || !src)
    throw coded('Not a media address.', 'not-media')
  return { kind: 'relay', src }
}

/** A media file or bytes ready to save or copy, with its type. */
interface Media {
  type: string
  ext: string
  kind: 'image' | 'video'
  /** The relay-media src (null for a data: image). */
  src: string | null
  file?: string
  bytes?: Buffer
}

async function materialize(ref: string, deps: MediaActionDeps): Promise<Media> {
  const source = parseMediaRef(ref)
  let type: string | null
  let file: string | undefined
  let bytes: Buffer | undefined
  if (source.kind === 'data') {
    type = source.type
    bytes = source.bytes
  } else {
    try {
      file = await resolveMedia(source.src, deps.media)
    } catch (e) {
      throw unavailable(e)
    }
    type = mediaTypeOf(file)
  }
  const ext = type === null ? null : extensionFor(type)
  // Images and videos only: a GLB, a PDF or audio is not what these actions are for.
  if (type === null || ext === null) throw coded("That isn't an image or a video.", 'not-media')
  return {
    type,
    ext,
    kind: type.startsWith('video/') ? 'video' : 'image',
    src: source.kind === 'relay' ? source.src : null,
    ...(file === undefined ? {} : { file }),
    ...(bytes === undefined ? {} : { bytes }),
  }
}

/** Save Image As / Save Video As. `name` is the caption shown with it, when there is one. */
export async function saveMedia(
  ref: string,
  name: string | undefined,
  deps: MediaActionDeps,
): Promise<{ path: string | null }> {
  const media = await materialize(ref, deps)
  const fileName = mediaFileName({
    ...(name === undefined ? {} : { caption: name }),
    src: media.src,
    ext: media.ext,
    kind: media.kind,
  })
  const dest = await deps.chooseSavePath({
    defaultPath: path.join(deps.downloadsDir(), fileName),
    title: media.kind === 'video' ? 'Save Video' : 'Save Image',
  })
  if (dest === null) return { path: null }
  // A clone (or a native copy) of the cached or local file: large videos never pass through JS.
  if (media.file !== undefined)
    await fs.promises.copyFile(media.file, dest, fs.constants.COPYFILE_FICLONE)
  else await fs.promises.writeFile(dest, media.bytes!)
  deps.onSaved?.(dest)
  return { path: dest }
}

/** Copy Image (its pixels; images only) or Copy Address (relay-media sources only). */
export async function copyMedia(
  ref: string,
  what: 'image' | 'address',
  deps: MediaActionDeps,
): Promise<{ copied: true }> {
  if (what === 'address') {
    const source = parseMediaRef(ref)
    if (source.kind !== 'relay') throw coded('This image has no address.', 'no-address')
    try {
      deps.writeText(mediaAddress(source.src, deps.media))
    } catch (e) {
      throw unavailable(e)
    }
    return { copied: true }
  }
  const media = await materialize(ref, deps)
  if (media.kind !== 'image') throw coded('Only an image can be copied.', 'not-media')
  await deps.writeImage(media.bytes ?? (await fs.promises.readFile(media.file!)))
  return { copied: true }
}
