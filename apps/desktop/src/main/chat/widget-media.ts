// Files a chat widget shows (images, audio, video, 3D models), served to the renderer over the
// `relay-media:` scheme. Port of EvaOS media.rs resolve(): a `src` is an http(s) URL (downloaded
// once into the cache), a Relay drop (`/drops/<id>/<token>`, or a video drop's
// `/drops/<id>/<token>/poster` frame, or an image pasted into a thread, `/artifacts/media/<sha>/<token>`,
// or a Studio output or upload, `/studio/<id>/<token>` and its `/thumb`; all immutable, fetched
// from the local Relay host and cached the same way), or a local file (`~/` or absolute) of a
// media type.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

export interface MediaDeps {
  /** Where downloads are kept (`<relay config>/widget-media`). */
  cacheDir: string
  /** The local Relay host's port, or null when it isn't running. */
  servePort(): number | null
  home: string
  /** Download timeout in ms (default 60 s). */
  timeoutMs?: number
  /** Largest download kept, in bytes (default 200 MB). */
  maxBytes?: number
}

const MAX_BYTES = 200 * 1024 * 1024
const TIMEOUT_MS = 60_000

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
}

/** The extension a download takes from its response type when its URL has none (drop paths). */
const EXT_FOR_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(MIME)
    .reverse()
    .map(([ext, type]) => [type, ext]),
)

export class MediaError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 413 | 502 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** A URL path's extension when it is a short one (media.rs: at most 5 characters after the dot). */
function urlExtension(url: string): string {
  const ext = path.extname(new URL(url).pathname).toLowerCase()
  return ext.length > 1 && ext.length <= 6 ? ext : ''
}

const inflight = new Map<string, Promise<string>>()

/** A downloaded copy of `url` in the cache, fetched once; concurrent callers share one fetch. */
function download(url: string, deps: MediaDeps): Promise<string> {
  const hash = createHash('sha256').update(url).digest('hex')
  const cached = fs.existsSync(deps.cacheDir)
    ? fs.readdirSync(deps.cacheDir).find((f) => f.startsWith(hash) && !f.endsWith('.part'))
    : undefined
  if (cached) return Promise.resolve(path.join(deps.cacheDir, cached))
  const running = inflight.get(hash)
  if (running) return running
  const job = fetchInto(url, hash, deps).finally(() => inflight.delete(hash))
  inflight.set(hash, job)
  return job
}

async function fetchInto(url: string, hash: string, deps: MediaDeps): Promise<string> {
  const max = deps.maxBytes ?? MAX_BYTES
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS) })
  } catch {
    throw new MediaError(502, `Couldn't download ${url}`)
  }
  if (res.status === 404) throw new MediaError(404, `Not found: ${url}`)
  if (!res.ok || !res.body) throw new MediaError(502, `Couldn't download ${url} (${res.status})`)
  if (Number(res.headers.get('content-length') ?? 0) > max)
    throw new MediaError(413, `${url} is over ${max} bytes`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  const ext = urlExtension(url) || EXT_FOR_TYPE[type] || ''
  fs.mkdirSync(deps.cacheDir, { recursive: true })
  const file = path.join(deps.cacheDir, hash + ext)
  const partial = `${file}.${process.pid}.${Date.now()}.part`
  let size = 0
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.byteLength
          if (size > max) throw new MediaError(413, `${url} is over ${max} bytes`)
          yield chunk
        }
      },
      fs.createWriteStream(partial),
    )
    fs.renameSync(partial, file)
    return file
  } catch (e) {
    fs.rmSync(partial, { force: true })
    if (e instanceof MediaError) throw e
    throw new MediaError(502, `Couldn't download ${url}`)
  }
}

/** A local file for `src`, downloading it first when it is remote. */
export async function resolveMedia(src: string, deps: MediaDeps): Promise<string> {
  if (/^https?:\/\//.test(src)) return download(src, deps)
  // Drops, images pasted into a thread (`/artifacts/media/<sha>/<token>`, the Artifacts panel) and
  // Studio's outputs and uploads (`/studio/<id>/<token>`, `/thumb` a JPEG preview).
  if (
    /^\/(?:drops\/[^/]+\/[^/]+(\/poster)?|artifacts\/media\/[^/]+\/[^/]+|studio\/[^/]+\/[^/]+(\/thumb)?)$/.test(
      src,
    )
  ) {
    const port = deps.servePort()
    if (port === null) throw new MediaError(503, "Relay isn't running, so its drop can't load")
    return download(`http://127.0.0.1:${port}${src}`, deps)
  }
  const local = src.startsWith('~/') ? path.join(deps.home, src.slice(2)) : src
  if (!path.isAbsolute(local)) throw new MediaError(400, `Not a media source: ${src}`)
  if (!(path.extname(local).toLowerCase() in MIME))
    throw new MediaError(403, `Not a media file: ${src}`)
  try {
    if (fs.statSync(local).isFile()) return local
  } catch {
    // Missing: reported below.
  }
  throw new MediaError(404, `Not found: ${src}`)
}

/** `bytes=a-b` against a file of `size` bytes: the inclusive span, or null when unsatisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    start = Math.max(size - Number(m[2]), 0)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start <= end && start < size ? { start, end } : null
}

/**
 * Answers one `relay-media://media/?src=<src>` request, with byte ranges for seeking. A HEAD gets
 * the headers only: chat markdown asks it whether a drop is a video (its Content-Type).
 */
export async function handleMediaRequest(request: Request, deps: MediaDeps): Promise<Response> {
  const src = new URL(request.url).searchParams.get('src')
  if (!src) return new Response('Missing src', { status: 400 })
  let file: string
  try {
    file = await resolveMedia(src, deps)
  } catch (e) {
    const status = e instanceof MediaError ? e.status : 502
    return new Response(e instanceof Error ? e.message : String(e), { status })
  }
  const size = fs.statSync(file).size
  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // The renderer is file:// (or the dev server); only it can reach this scheme.
    'Access-Control-Allow-Origin': '*',
  }
  const rangeHeader = request.headers.get('range')
  const range = rangeHeader ? parseRange(rangeHeader, size) : null
  if (rangeHeader && !range)
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  const { start, end } = range ?? { start: 0, end: size - 1 }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  headers['Content-Length'] = String(end - start + 1)
  const stream =
    size === 0 || request.method === 'HEAD'
      ? null
      : (Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream)
  return new Response(stream, { status: range ? 206 : 200, headers })
}
