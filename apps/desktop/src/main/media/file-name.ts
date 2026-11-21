/**
 * The name Save Image As / Save Video As offers: the caption as a slug, else the drop's id (or the
 * source's own file name), else `image` / `video`, with the extension of what is really saved.
 * Never a token, a query string or a directory: a drop's token and a signed URL's query are
 * secrets, and the name lands in a folder Isaac picks.
 */

/** Longest stem offered, in characters (before the extension). */
const STEM_MAX = 80

/** A media file extension a caption may end with (`shot.png`): dropped, the real one is added. */
const MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|mp4|m4v|mov|webm|ogv)$/i

/** What the viewer and widgets call an image without a caption: no better than the fallback. */
const GENERIC = /^(?:image|video|picture|photo|file)(?:[\s-]+\d+(?:\s+of\s+\d+)?)?$/i

/** The extension a file of this media type is saved with. */
const EXT_FOR_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
}

/** The extension for a media type, or null for a type that is not an image or video. */
export function extensionFor(type: string): string | null {
  return EXT_FOR_TYPE[type.split(';')[0]!.trim().toLowerCase()] ?? null
}

/** `Sunset over the Bay!` as `sunset-over-the-bay`: letters and digits of any script, dashes between. */
export function slugOf(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STEM_MAX)
    .replace(/-+$/, '')
}

/** A caption's stem, or '' when it says nothing (empty, `Image 2 of 3`). */
function captionStem(caption: string | undefined): string {
  const text = (caption ?? '').trim().replace(MEDIA_EXT, '')
  return GENERIC.test(text) ? '' : slugOf(text)
}

/**
 * The stem a source names, without its secret parts: a drop's, Studio file's or meeting's id
 * (`/drops/<id>/<token>`), a pasted image's content hash, or a URL's or path's last file name.
 */
export function sourceStem(src: string | null): string {
  if (src === null) return ''
  const drop = /^\/drops\/([^/]+)\/[^/]+(\/poster)?$/.exec(src)
  if (drop) return slugOf(drop[2] ? `${drop[1]}-poster` : drop[1]!)
  const studio = /^\/studio\/([^/]+)\/[^/]+(\/thumb)?$/.exec(src)
  if (studio) return slugOf(studio[2] ? `${studio[1]}-thumb` : studio[1]!)
  const pasted = /^\/artifacts\/media\/([^/]+)\/[^/]+$/.exec(src)
  if (pasted) return slugOf(pasted[1]!.slice(0, 12))
  const shot = /^\/meetings\/shots\/([^/]+)\/[^/]+\/(\d+)$/.exec(src)
  if (shot) return slugOf(`${shot[1]}-${shot[2]}`)
  let pathname = src
  if (/^https?:\/\//i.test(src)) {
    try {
      pathname = new URL(src).pathname
    } catch {
      return ''
    }
  }
  const last = pathname.split('/').pop() ?? ''
  let name = last
  try {
    name = decodeURIComponent(last)
  } catch {
    // A stray % keeps the raw segment.
  }
  return slugOf(name.replace(/\.[^.]*$/, ''))
}

/**
 * The file name offered for a save: `<caption slug or source stem or kind><ext>`. `ext` is the
 * saved file's real extension (with its dot).
 */
export function mediaFileName(opts: {
  caption?: string | undefined
  src: string | null
  ext: string
  kind: 'image' | 'video'
}): string {
  const stem = captionStem(opts.caption) || sourceStem(opts.src) || opts.kind
  return `${stem}${opts.ext.toLowerCase()}`
}
