// Images in Reviews markdown (PR descriptions and comments, Linear descriptions and comments).
// GitHub's uploads (`github.com/user-attachments/assets/...`, `private-user-images...`) and
// Linear's (`uploads.linear.app`) only open with Isaac's credentials, and GitHub writes most of
// them as HTML `<img>` tags, which the app's markdown never renders. So main downloads each one
// once, with the right auth, into `<configDir>/reviews-media/<sha1 of the url><ext>`, and the
// markdown points at the served path `/reviews/media/<file>` (the same shape as Relay Host's), which
// the `relay-media:` scheme resolves (chat/widget-media.ts). Never a filesystem path: a config dir
// like "Application Support/Relay Dev" has spaces, which break a markdown link, and a raw path must
// not travel into a comment or an Astra prompt.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

export const REVIEWS_MEDIA_DIR = 'reviews-media'
export const REVIEWS_MEDIA_PREFIX = '/reviews/media/'

const EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}
const NAME = /^[0-9a-f]{40}\.(?:png|jpg|gif|webp)$/

/** The file a served `/reviews/media/<name>` path names inside `dir`; null for anything else. */
export function reviewsMediaFile(dir: string, src: string): string | null {
  if (!src.startsWith(REVIEWS_MEDIA_PREFIX)) return null
  const name = src.slice(REVIEWS_MEDIA_PREFIX.length)
  return NAME.test(name) ? path.join(dir, name) : null
}

/** `![alt](url)`, `![alt](<url>)`, `![alt](url "title")` and `<img ... src="url" ...>`. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?\s*\)|<img\b[^>]*>/gi

/** An HTML attribute's value, quoted or not. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    tag,
  )
  return m?.[1] ?? m?.[2] ?? m?.[3]
}

const cleanAlt = (alt: string): string =>
  alt
    .replace(/[[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** An `<img>`'s pixel width: its `width` attribute, else a `width: Npx` in its style. */
function htmlWidth(tag: string): number | undefined {
  const w =
    /^(\d+)(?:px)?\/?$/i.exec(attr(tag, 'width') ?? '')?.[1] ??
    /(?:^|;)\s*width\s*:\s*(\d+)(?:\.\d+)?px/i.exec(attr(tag, 'style') ?? '')?.[1]
  return w === undefined || Number(w) === 0 ? undefined : Number(w)
}

interface Image {
  alt: string
  url: string
  /** The markdown title: an `<img>`'s width as `w=N` (the renderer's bounded width), else its title. */
  title: string | undefined
}

/** One `IMAGE` match as an image; undefined for an `<img>` without a `src`. */
function image(
  whole: string,
  alt: string | undefined,
  url: string | undefined,
  title: string | undefined,
): Image | undefined {
  if (!whole.startsWith('<')) return url ? { alt: alt ?? '', url, title } : undefined
  const src = attr(whole, 'src')
  if (!src) return undefined
  const width = htmlWidth(whole)
  return {
    alt: attr(whole, 'alt') ?? '',
    url: src,
    title: width === undefined ? attr(whole, 'title') : `w=${width}`,
  }
}

function markdownImage(i: Image, url: string): string {
  const title = (i.title ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim()
  return `![${cleanAlt(i.alt)}](${url}${title === '' ? '' : ` "${title}"`})`
}

export interface MediaSource {
  /** Whether this host's images are downloaded (else the URL stays as it is). */
  match: (url: string) => boolean
  /** Request headers for one download (auth), sent only to this URL's own origin. */
  headers: () => Promise<Record<string, string>>
}

/**
 * Rewrites every image in `md`: HTML `<img>` tags become markdown images (their width kept as the
 * title `w=N`), titles stay, and images a source matches are downloaded once and point at
 * `/reviews/media/<file>`. An image that fails to download keeps its URL. Downloads run in
 * parallel; a file already in `dir` is reused.
 */
export async function localizeImages(
  md: string,
  dir: string,
  sources: readonly MediaSource[],
  limits: MediaLimits = MEDIA_LIMITS,
): Promise<string> {
  const urls = new Set<string>()
  for (const m of md.matchAll(IMAGE)) {
    const url = image(m[0], m[1], m[2], m[3])?.url
    if (url) urls.add(url)
  }
  const local = new Map(
    await Promise.all(
      [...urls].map(async (url) => {
        const source = sources.find((s) => s.match(url))
        return [url, source ? await download(url, dir, source, limits) : url] as const
      }),
    ),
  )
  return md.replace(IMAGE, (whole: string, alt?: string, mdUrl?: string, title?: string) => {
    const i = image(whole, alt, mdUrl, title)
    return i ? markdownImage(i, local.get(i.url) ?? i.url) : whole
  })
}

/** A URL as origin + path: a signed URL's query (GitHub's JWT) never goes into an error or a log. */
export function redactUrl(url: string): string {
  if (!URL.canParse(url)) return '(a bad URL)'
  const u = new URL(url)
  return `${u.origin}${u.pathname}`
}

const MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 3
const REDIRECT = new Set([301, 302, 303, 307, 308])

async function request(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, { headers, redirect: 'manual', signal })
  } catch {
    throw new Error(`Couldn't fetch ${redactUrl(url)}`)
  }
}

/** Where a redirect from `url` leads; only another private upload over HTTPS, at most `MAX_REDIRECTS` times. */
function nextHop(res: Response, url: string, hop: number): string {
  if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects at ${redactUrl(url)}`)
  const location = res.headers.get('location') ?? ''
  const next = URL.canParse(location, url) ? new URL(location, url).href : ''
  if (!isGithubUpload(next) && !isLinearUpload(next))
    throw new Error(`${redactUrl(url)} redirected to a host that is not allowed`)
  return next
}

/** The body, refused past `MAX_BYTES` (announced or streamed). */
async function capped(res: Response, url: string): Promise<Buffer> {
  const tooBig = (): Error => new Error(`${redactUrl(url)} is over 10 MB`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw tooBig()
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (let r = await reader?.read(); r && !r.done; r = await reader?.read()) {
    size += r.value.byteLength
    if (size > MAX_BYTES) {
      await reader?.cancel()
      throw tooBig()
    }
    chunks.push(r.value)
  }
  return Buffer.concat(chunks, size)
}

/**
 * One image: redirects followed by hand, auth only to `url`'s own origin (a GitHub token never goes
 * to another host, a Linear key never to GitHub), at most 10 MB in 20 s. Errors name the URL
 * without its query.
 */
export async function fetchMedia(
  url: string,
  headers: Record<string, string>,
): Promise<{ ext: string; bytes: Buffer }> {
  const signal = AbortSignal.timeout(20_000)
  const origin = new URL(url).origin
  let at = url
  for (let hop = 0; ; hop += 1) {
    const res = await request(at, new URL(at).origin === origin ? headers : {}, signal)
    if (REDIRECT.has(res.status)) {
      at = nextHop(res, at, hop)
      continue
    }
    if (!res.ok) throw new Error(`${redactUrl(at)} answered ${res.status}`)
    const ext = EXT[(res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()]
    if (!ext) throw new Error(`${redactUrl(at)} is not an image`)
    return { ext, bytes: await capped(res, at) }
  }
}

export interface MediaLimits {
  files: number
  bytes: number
}

/** The media dir's bound: past either, the oldest files go (an evicted one downloads again on its next render). */
export const MEDIA_LIMITS: MediaLimits = { files: 2000, bytes: 500 * 1024 * 1024 }
const RESCAN_MS = 5 * 60_000

/** Per dir: files and bytes at the last full scan plus what was written since. */
const tallies = new Map<string, { files: number; bytes: number; scannedAt: number }>()

/** Deletes the oldest media files of `dir` (never `newest`) until it fits `limits`; answers what is left. */
function evictOldest(
  dir: string,
  newest: string,
  limits: MediaLimits,
): { files: number; bytes: number } {
  const files = fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .flatMap((name) => {
      const s = fs.statSync(path.join(dir, name), { throwIfNoEntry: false })
      return s?.isFile() ? [{ name, size: s.size, mtime: s.mtimeMs }] : []
    })
    .sort((a, b) => a.mtime - b.mtime)
  const left = { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }
  for (const f of files) {
    if (left.files <= limits.files && left.bytes <= limits.bytes) break
    if (f.name === newest) continue
    fs.rmSync(path.join(dir, f.name), { force: true })
    left.files -= 1
    left.bytes -= f.size
  }
  return left
}

/** After `name` (`size` bytes) is written: counts are estimates between full scans (the first write, then at most every 5 minutes or when over `limits`). */
function bound(dir: string, name: string, size: number, limits: MediaLimits): void {
  const now = Date.now()
  const t = tallies.get(dir)
  if (t && now - t.scannedAt < RESCAN_MS) {
    t.files += 1
    t.bytes += size
    if (t.files <= limits.files && t.bytes <= limits.bytes) return
  }
  tallies.set(dir, { ...evictOldest(dir, name, limits), scannedAt: now })
}

const inflight = new Map<string, Promise<string>>()

/** `url` as `/reviews/media/<file>`, downloaded once; the URL itself when it can't be fetched. */
function download(
  url: string,
  dir: string,
  source: MediaSource,
  limits: MediaLimits,
): Promise<string> {
  const hash = createHash('sha1').update(url).digest('hex')
  const have = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.startsWith(`${hash}.`) && NAME.test(f))
    : undefined
  if (have) return Promise.resolve(REVIEWS_MEDIA_PREFIX + have)
  const running = inflight.get(hash)
  if (running) return running
  const job = (async (): Promise<string> => {
    try {
      const { ext, bytes } = await fetchMedia(url, await source.headers())
      fs.mkdirSync(dir, { recursive: true })
      const name = `${hash}${ext}`
      const part = path.join(dir, `.${name}.${process.pid}.part`)
      fs.writeFileSync(part, bytes)
      fs.renameSync(part, path.join(dir, name))
      bound(dir, name, bytes.length, limits)
      return REVIEWS_MEDIA_PREFIX + name
    } catch {
      return url
    }
  })().finally(() => inflight.delete(hash))
  inflight.set(hash, job)
  return job
}

/** `url` when it is plain HTTPS on the default port without credentials; null otherwise. */
function https(url: string): URL | null {
  const u = URL.canParse(url) ? new URL(url) : null
  return u?.protocol === 'https:' && u.port === '' && u.username === '' && u.password === ''
    ? u
    : null
}

/** GitHub's attachments, which only open signed in. */
export const isGithubUpload = (url: string): boolean => {
  const u = https(url)
  return (
    (u?.hostname === 'github.com' && u.pathname.startsWith('/user-attachments/assets/')) ||
    u?.hostname === 'private-user-images.githubusercontent.com'
  )
}

/** Linear's uploads (signed ones open without the key too; the key never hurts). */
export const isLinearUpload = (url: string): boolean =>
  https(url)?.hostname === 'uploads.linear.app'
