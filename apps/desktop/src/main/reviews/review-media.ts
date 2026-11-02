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

/** `![alt](url)`, `![alt](<url>)` and `<img ... src="url" ...>`. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*>/gi

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
    .exec(tag)
    ?.slice(2)
    .find((v) => v !== undefined)

const cleanAlt = (alt: string): string =>
  alt
    .replace(/[[\]\n\r]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

export interface MediaSource {
  /** Whether this host's images are downloaded (else the URL stays as it is). */
  match: (url: string) => boolean
  /** Request headers for one download (auth). */
  headers: () => Promise<Record<string, string>>
}

/**
 * Rewrites every image in `md`: HTML `<img>` tags become markdown images, and images a source
 * matches are downloaded once and point at `/reviews/media/<file>`. An image that fails to download
 * keeps its URL. Downloads run in parallel; a file already in `dir` is reused.
 */
export async function localizeImages(
  md: string,
  dir: string,
  sources: readonly MediaSource[],
): Promise<string> {
  const images: Array<{ alt: string; url: string }> = []
  for (const m of md.matchAll(IMAGE)) {
    const url = m[0].startsWith('<') ? attr(m[0], 'src') : m[2]
    if (url) images.push({ alt: m[0].startsWith('<') ? (attr(m[0], 'alt') ?? '') : m[1]!, url })
  }
  const urls = [...new Set(images.map((i) => i.url))]
  const local = new Map(
    await Promise.all(
      urls.map(async (url) => {
        const source = sources.find((s) => s.match(url))
        return [url, source ? await download(url, dir, source) : url] as const
      }),
    ),
  )
  return md.replace(IMAGE, (whole: string, alt?: string, mdUrl?: string) => {
    const html = whole.startsWith('<')
    const url = html ? attr(whole, 'src') : mdUrl
    if (!url) return whole
    const text = cleanAlt(html ? (attr(whole, 'alt') ?? '') : (alt ?? ''))
    return `![${text}](${local.get(url) ?? url})`
  })
}

const inflight = new Map<string, Promise<string>>()

/** `url` as `/reviews/media/<file>`, downloaded once; the URL itself when it can't be fetched. */
function download(url: string, dir: string, source: MediaSource): Promise<string> {
  const hash = createHash('sha1').update(url).digest('hex')
  const have = fs.existsSync(dir)
    ? fs.readdirSync(dir).find((f) => f.startsWith(`${hash}.`) && NAME.test(f))
    : undefined
  if (have) return Promise.resolve(REVIEWS_MEDIA_PREFIX + have)
  const running = inflight.get(hash)
  if (running) return running
  const job = (async (): Promise<string> => {
    try {
      const res = await fetch(url, {
        headers: await source.headers(),
        signal: AbortSignal.timeout(20_000),
      })
      const ext = EXT[(res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()]
      if (!res.ok || !ext) return url
      fs.mkdirSync(dir, { recursive: true })
      const name = `${hash}${ext}`
      const part = path.join(dir, `.${name}.${process.pid}.part`)
      fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()))
      fs.renameSync(part, path.join(dir, name))
      return REVIEWS_MEDIA_PREFIX + name
    } catch {
      return url
    }
  })().finally(() => inflight.delete(hash))
  inflight.set(hash, job)
  return job
}

/** GitHub's attachments, which only open signed in. */
export const isGithubUpload = (url: string): boolean =>
  /^https:\/\/(?:github\.com\/user-attachments\/assets\/|private-user-images\.githubusercontent\.com\/)/.test(
    url,
  )

/** Linear's uploads (signed ones open without the key too; the key never hurts). */
export const isLinearUpload = (url: string): boolean =>
  url.startsWith('https://uploads.linear.app/')
