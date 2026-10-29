import { createContext, useContext, useEffect, useState } from 'react'
import { ImageViewer } from '../ImageViewer'
import { mediaUrl } from '../widgets/media-url'

/**
 * `![caption](src)` in a reply: an image, or an inline video when `src` is one. Agents embed both
 * the same way, so the client decides (the Relay drop contract):
 * - a Relay drop (`/drops/<id>/<token>`) is a video when its served Content-Type is `video/*`;
 *   main answers a HEAD on the relay-media: URL with the drop's type, and the poster frame is the
 *   drop's `/poster` path when the host made one;
 * - an http(s) URL is a video when its path ends .mp4, .webm, .mov or .m4v;
 * - everything else stays an image.
 */
export type MediaKind = { kind: 'image' } | { kind: 'video'; poster: string | null }

const DROP = /^\/drops\/[^/]+\/[^/]+$/
const VIDEO_PATH = /\.(mp4|webm|mov|m4v)$/i
const IMAGE: MediaKind = { kind: 'image' }
const URL_VIDEO: MediaKind = { kind: 'video', poster: null }

/** Whether an http(s) src is a video by its URL path. */
export function urlIsVideo(src: string): boolean {
  if (!/^https?:\/\//i.test(src)) return false
  try {
    return VIDEO_PATH.test(new URL(src).pathname)
  } catch {
    return false
  }
}

/** What a src is without asking main: known for URLs and files, null for a drop not probed yet. */
function knownKind(src: string): MediaKind | null {
  if (DROP.test(src)) return probed.get(src) ?? null
  return urlIsVideo(src) ? URL_VIDEO : IMAGE
}

/** Settled drop probes, so a row the virtual list remounts draws at once. */
const probed = new Map<string, MediaKind>()
const probing = new Map<string, Promise<MediaKind>>()

async function head(src: string): Promise<Response> {
  const res = await fetch(mediaUrl(src), { method: 'HEAD' })
  if (!res.ok) throw new Error(`${src}: ${res.status}`)
  return res
}

/**
 * A drop's kind from its served Content-Type, and for a video whether its poster exists. Settled
 * answers are kept; a failure (Relay not running, drop gone) is not, so a later mount asks again,
 * and meanwhile the src draws as an image like before.
 */
export function probeDrop(src: string): Promise<MediaKind> {
  const running = probing.get(src)
  if (running) return running
  const job = (async (): Promise<MediaKind> => {
    const type = (await head(src)).headers.get('content-type') ?? ''
    if (!type.toLowerCase().startsWith('video/')) return IMAGE
    const posterSrc = `${src}/poster`
    const poster = await head(posterSrc).then(
      () => mediaUrl(posterSrc),
      () => null,
    )
    return { kind: 'video', poster }
  })().then(
    (kind) => {
      probed.set(src, kind)
      return kind
    },
    () => IMAGE,
  )
  probing.set(src, job)
  void job.finally(() => probing.delete(src))
  return job
}

/** Test hook: forget every drop probe. */
export function clearMediaProbes(): void {
  probed.clear()
  probing.clear()
}

function useMediaKind(src: string): MediaKind | null {
  const [kind, setKind] = useState(() => knownKind(src))
  useEffect(() => {
    const known = knownKind(src)
    setKind(known)
    if (known) return
    let live = true
    void probeDrop(src).then((k) => {
      if (live) setKind(k)
    })
    return () => {
      live = false
    }
  }, [src])
  return kind
}

function MarkdownVideo({
  src,
  poster,
  caption,
}: {
  src: string
  poster: string | null
  caption: string
}) {
  const [failed, setFailed] = useState(false)
  // Spans, not a figure: markdown puts the image inside a paragraph.
  return (
    <span className="eva-md-video" data-testid="md-video">
      {failed ? (
        <span className="eva-md-video-error">Couldn&apos;t load video</span>
      ) : (
        <video
          src={mediaUrl(src)}
          poster={poster ?? undefined}
          controls
          preload="metadata"
          playsInline
          aria-label={caption || 'Video'}
          onError={() => setFailed(true)}
        />
      )}
      {caption ? <span className="eva-md-video-caption">{caption}</span> : null}
    </span>
  )
}

/** True inside a markdown link: a linked image follows its link instead of opening the viewer. */
export const InLink = createContext(false)

/** An image in a reply: a click (or Enter) opens it full size in the image viewer, like a widget's. */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [viewing, setViewing] = useState(false)
  const url = mediaUrl(src)
  if (useContext(InLink)) return <img src={url} alt={alt} draggable={false} />
  return (
    <>
      <button
        type="button"
        className="eva-md-image"
        aria-label={`Open ${alt || 'image'}`}
        data-testid="md-image"
        onClick={() => setViewing(true)}
      >
        <img src={url} alt={alt} draggable={false} />
      </button>
      <ImageViewer
        images={[{ label: alt, src: url }]}
        start={0}
        opened={viewing}
        onClose={() => setViewing(false)}
      />
    </>
  )
}

/** Drops, http(s) URLs and local files all load through main's relay-media protocol, like widgets. */
export function MarkdownMedia({ src, alt }: { src: string; alt: string }) {
  const kind = useMediaKind(src)
  if (kind === null) return <span className="eva-md-media-pending" data-testid="md-media-pending" />
  if (kind.kind === 'video') return <MarkdownVideo src={src} poster={kind.poster} caption={alt} />
  return <MarkdownImage src={src} alt={alt} />
}
